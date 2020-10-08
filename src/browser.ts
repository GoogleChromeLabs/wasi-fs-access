// Copyright 2020 Google Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import Bindings, { OpenFlags } from './bindings.js';
import { FileOrDir, OpenFiles } from './fileSystem.js';

declare const Terminal: typeof import('xterm').Terminal;
declare const LocalEchoController: any;
declare const FitAddon: typeof import('xterm-addon-fit');
declare const WebLinksAddon: typeof import('xterm-addon-web-links');

// Backports for new APIs to Chromium <=85.
let hasSupport = true;
try {
  navigator.storage.getDirectory ??= () =>
    FileSystemDirectoryHandle.getSystemDirectory({
      type: 'sandbox'
    });
  FileSystemDirectoryHandle.prototype.getDirectoryHandle ??=
    FileSystemDirectoryHandle.prototype.getDirectory;
  FileSystemDirectoryHandle.prototype.getFileHandle ??=
    FileSystemDirectoryHandle.prototype.getFile;
  FileSystemDirectoryHandle.prototype.values ??= function (
    this: FileSystemDirectoryHandle
  ) {
    return this.getEntries()[Symbol.asyncIterator]();
  };
  globalThis.showDirectoryPicker ??= () =>
    chooseFileSystemEntries({
      type: 'open-directory'
    });
  // @ts-expect-error
  if (!('kind' in FileSystemHandle.prototype)) {
    // @ts-expect-error
    Object.defineProperty(FileSystemHandle.prototype, 'kind', {
      get(this: FileSystemHandle): FileSystemHandleKind {
        return this.isFile ? 'file' : 'directory';
      }
    });
  }
} catch {
  hasSupport = false;
}

(async () => {
  const module = WebAssembly.compileStreaming(fetch('./uutils.async.wasm'));

  let term = new Terminal();

  let fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  let localEcho = new LocalEchoController();
  term.loadAddon(localEcho);

  term.loadAddon(new WebLinksAddon.WebLinksAddon());

  term.open(document.body);
  fitAddon.fit();
  onresize = () => fitAddon.fit();

  function writeIndented(s: string) {
    term.write(s.trimStart().replace(/\n +/g, '\r\n'));
  }

  writeIndented(`
    # Welcome to a shell powered by WebAssembly, WASI, Asyncify and File System Access API!
    # Github repo with the source code and details: https://github.com/GoogleChromeLabs/wasi-fs-access

  `);
  if (!hasSupport) {
    writeIndented(`
      Looks like your browser doesn't have support for the File System Access API.
      Please try a Chromium-based browser such as Google Chrome or Microsoft Edge.
    `);
    return;
  }
  writeIndented(`
    # Right now you have /sandbox mounted to a persistent sandbox filesystem:
    $ df -a
    Filesystem          1k-blocks         Used    Available  Use% Mounted on
    wasi                        0            0            0     - /sandbox

    # To mount a real directory, type "mount /mount/point" and choose a source in the dialogue.
    # To view a list of other commands, type "help".
    # Happy hacking!

  `);

  const stdout = {
    decoder: new TextDecoder(),
    write(data: Uint8Array) {
      term.write(
        this.decoder.decode(data, { stream: true }).replaceAll('\n', '\r\n')
      );
    }
  };

  const cmdParser = /(?:'(.*?)'|"(.*?)"|(\S+))\s*/gsuy;

  let preOpen: Record<string, FileSystemDirectoryHandle> = {};
  preOpen['/sandbox'] = await navigator.storage.getDirectory();

  while (true) {
    let line = await localEcho.read('$ ');
    localEcho.history.rewind();
    let args = Array.from(
      line.matchAll(cmdParser),
      ([, s1, s2, s3]) => s1 ?? s2 ?? s3
    );
    try {
      if (!args.length) {
        continue;
      }
      switch (args[0]) {
        case 'help':
          args[0] = '--help';
          break;
        case 'mount':
          preOpen[args[1]] = await showDirectoryPicker();
          continue;
        case 'cd':
        case 'pwd':
          writeIndented(`
            Unfortunately, WASI doesn't have a concept of current working directory yet: https://github.com/WebAssembly/WASI/issues/303
            Meanwhile, please pass absolute paths to all commands, e.g. "ls /some/path".
          `);
          continue;
        case 'ln':
        case 'link':
          writeIndented(`
            Unfortunately, File System Access API doesn't support symlinks yet.
          `);
          continue;
      }
      let openFiles = new OpenFiles(preOpen);
      let redirectedStdout;
      if (args[args.length - 2] === '>') {
        let path = args.pop();
        let { preOpen, relativePath } = openFiles.findRelPath(path);
        args.pop(); // '>'
        let handle = await preOpen.getFileOrDir(
          relativePath,
          FileOrDir.File,
          OpenFlags.Create
        );
        redirectedStdout = await handle.createWritable();
      }
      let statusCode = await new Bindings({
        openFiles,
        stdout: redirectedStdout ?? stdout,
        stderr: stdout,
        args,
        env: {
          RUST_BACKTRACE: '1'
        }
      }).run(await module);
      if (redirectedStdout) {
        await redirectedStdout.close();
      }
      if (statusCode !== 0) {
        term.writeln(`Exit code: ${statusCode}`);
      }
    } catch (err) {
      term.writeln(err.message);
    }
  }
})();
