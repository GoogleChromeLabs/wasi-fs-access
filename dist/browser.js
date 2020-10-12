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
import Bindings, { stringOut } from './bindings.js';
import { OpenFiles } from './fileSystem.js';
// Backports for new APIs to Chromium <=85.
let hasSupport = true;
try {
    navigator.storage.getDirectory ??= () => FileSystemDirectoryHandle.getSystemDirectory({
        type: 'sandbox'
    });
    FileSystemDirectoryHandle.prototype.getDirectoryHandle ??=
        FileSystemDirectoryHandle.prototype.getDirectory;
    FileSystemDirectoryHandle.prototype.getFileHandle ??=
        FileSystemDirectoryHandle.prototype.getFile;
    FileSystemDirectoryHandle.prototype.values ??= function () {
        return this.getEntries()[Symbol.asyncIterator]();
    };
    globalThis.showDirectoryPicker ??= () => chooseFileSystemEntries({
        type: 'open-directory'
    });
    if (!('kind' in FileSystemHandle.prototype)) {
        Object.defineProperty(FileSystemHandle.prototype, 'kind', {
            get() {
                return this.isFile ? 'file' : 'directory';
            }
        });
    }
}
catch {
    hasSupport = false;
}
(async () => {
    const module = WebAssembly.compileStreaming(fetch('./uutils.async.wasm'));
    let knownCommands = ['help', 'mount'];
    // This is just for the autocomplete, so spawn the task and ignore any errors.
    (async () => {
        let helpStr = '';
        await new Bindings({
            openFiles: new OpenFiles({}),
            args: ['--help'],
            stdout: stringOut(chunk => (helpStr += chunk))
        }).run(await module);
        knownCommands = knownCommands.concat(helpStr
            .match(/Currently defined functions\/utilities:(.*)/s)[1]
            .match(/[\w-]+/g));
    })();
    let term = new Terminal();
    let fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    let localEcho = new LocalEchoController();
    localEcho.addAutocompleteHandler((index) => index === 0 ? knownCommands : []);
    term.loadAddon(localEcho);
    {
        let storedHistory = localStorage.getItem('command-history');
        if (storedHistory) {
            localEcho.history.entries = storedHistory.split('\n');
            localEcho.history.rewind();
        }
    }
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
    term.open(document.body);
    fitAddon.fit();
    onresize = () => fitAddon.fit();
    const ANSI_GRAY = '\x1B[38;5;251m';
    const ANSI_BLUE = '\x1B[34;1m';
    const ANSI_RESET = '\x1B[0m';
    function writeIndented(s) {
        term.write(s
            .trimStart()
            .replace(/\n +/g, '\r\n')
            .replace(/https:\S+/g, ANSI_BLUE + '$&' + ANSI_RESET)
            .replace(/^#.*$/gm, ANSI_GRAY + '$&' + ANSI_RESET));
    }
    writeIndented(`
    # Welcome to a shell powered by WebAssembly, WASI, Asyncify and File System Access API!
    # Github repo with the source code and details: https://github.com/GoogleChromeLabs/wasi-fs-access

  `);
    if (!hasSupport) {
        writeIndented(`
      Looks like your browser doesn't have support for the File System Access API yet.
      Please try a Chromium-based browser such as Google Chrome or Microsoft Edge.
    `);
        return;
    }
    writeIndented(`
    # Right now you have /sandbox mounted to a persistent sandbox filesystem:
    $ df -a
    Filesystem          1k-blocks         Used    Available  Use% Mounted on
    wasi                        0            0            0     - /sandbox

    # To mount a real directory, use command
    $ mount /mount/point
    # and choose a source in the dialogue.

    # To view a list of other commands, use
    $ help

    # Happy hacking!
  `);
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();
    const stdout = {
        write(data) {
            term.write(textDecoder.decode(data, { stream: true }).replaceAll('\n', '\r\n'));
        }
    };
    const cmdParser = /(?:'(.*?)'|"(.*?)"|(\S+))\s*/gsuy;
    let preOpen = {};
    preOpen['/sandbox'] = await navigator.storage.getDirectory();
    while (true) {
        let line = await localEcho.read('$ ');
        localEcho.history.rewind();
        localStorage.setItem('command-history', localEcho.history.entries.join('\n'));
        let args = Array.from(line.matchAll(cmdParser), ([, s1, s2, s3]) => s1 ?? s2 ?? s3);
        try {
            if (!args.length) {
                continue;
            }
            switch (args[0]) {
                case 'help':
                    args[0] = '--help';
                    break;
                case 'mount': {
                    let dest = args[1];
                    if (!dest || dest === '--help') {
                        term.writeln('Provide a desination mount point like "mount /mount/point" and choose a source in the dialogue.');
                        continue;
                    }
                    let src = (preOpen[dest] = await showDirectoryPicker());
                    term.writeln(`Successfully mounted (...host path...)/${src.name} at ${dest}.`);
                    continue;
                }
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
                let handle = await preOpen.getFileOrDir(relativePath, 1 /* File */, 1 /* Create */);
                redirectedStdout = await handle.createWritable();
            }
            localEcho.detach();
            let abortController = new AbortController();
            let ctrlCHandler = term.onData(s => {
                if (s === '\x03') {
                    term.write('^C');
                    abortController.abort();
                }
            });
            try {
                let statusCode = await new Bindings({
                    abortSignal: abortController.signal,
                    openFiles,
                    stdin: {
                        async read() {
                            let onData;
                            let line = '';
                            try {
                                await new Promise((resolve, reject) => {
                                    onData = term.onData(s => {
                                        // Ctrl+D
                                        if (s === '\x04') {
                                            term.writeln('^D');
                                            return resolve();
                                        }
                                        // Enter
                                        if (s === '\r') {
                                            term.writeln('');
                                            line += '\n';
                                            return resolve();
                                        }
                                        // Ignore other functional keys
                                        if (s.charCodeAt(0) < 32) {
                                            return;
                                        }
                                        // Backspace
                                        if (s === '\x7F') {
                                            term.write('\b \b');
                                            line = line.slice(0, -1);
                                            return;
                                        }
                                        term.write(s);
                                        line += s;
                                    });
                                });
                            }
                            finally {
                                onData.dispose();
                            }
                            return textEncoder.encode(line);
                        }
                    },
                    stdout: redirectedStdout ?? stdout,
                    stderr: stdout,
                    args,
                    env: {
                        RUST_BACKTRACE: '1'
                    }
                }).run(await module);
                if (statusCode !== 0) {
                    term.writeln(`Exit code: ${statusCode}`);
                }
            }
            finally {
                ctrlCHandler.dispose();
                localEcho.attach();
                if (redirectedStdout) {
                    await redirectedStdout.close();
                }
            }
        }
        catch (err) {
            term.writeln(err.message);
        }
    }
})();
//# sourceMappingURL=browser.js.map