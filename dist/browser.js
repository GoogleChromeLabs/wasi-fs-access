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
    let term = new Terminal();
    let fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    let localEcho = new LocalEchoController();
    let knownCommands = ['help', 'mount', 'cd'];
    localEcho.addAutocompleteHandler((index) => index === 0 ? knownCommands : []);
    {
        let storedHistory = localStorage.getItem('command-history');
        if (storedHistory) {
            localEcho.history.entries = storedHistory.split('\n');
            localEcho.history.rewind();
        }
    }
    term.loadAddon(localEcho);
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
    const module = WebAssembly.compileStreaming(fetch('./coreutils.async.wasm'));
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
    const stdin = {
        async read() {
            let onData;
            let line = '';
            try {
                await new Promise(resolve => {
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
    };
    const stdout = {
        write(data) {
            term.write(textDecoder.decode(data, { stream: true }).replaceAll('\n', '\r\n'));
        }
    };
    const cmdParser = /(?:'(.*?)'|"(.*?)"|(\S+))\s*/gsuy;
    let preOpens = {};
    preOpens['/sandbox'] = await navigator.storage.getDirectory();
    let pwd = '/sandbox';
    while (true) {
        let line = await localEcho.read(`${pwd}$ `);
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
                    if (!dest || dest === '--help' || !dest.startsWith('/')) {
                        term.writeln('Provide a desination mount point like "mount /mount/point" and choose a source in the dialogue.');
                        continue;
                    }
                    let src = (preOpens[dest] = await showDirectoryPicker());
                    term.writeln(`Successfully mounted (...host path...)/${src.name} at ${dest}.`);
                    continue;
                }
                case 'cd': {
                    let dest = args[1];
                    if (dest) {
                        // Resolve against the current working dir.
                        dest = new URL(dest, `file://${pwd}/`).pathname;
                        if (dest.endsWith('/')) {
                            dest = dest.slice(0, -1) || '/';
                        }
                        let openFiles = new OpenFiles(preOpens);
                        let { preOpen, relativePath } = openFiles.findRelPath(dest);
                        await preOpen.getFileOrDir(relativePath, 2 /* Dir */, 2 /* Directory */);
                        // We got here without failing, set the new working dir.
                        pwd = dest;
                    }
                    else {
                        term.writeln('Provide the directory argument.');
                    }
                    continue;
                }
            }
            let openFiles = new OpenFiles(preOpens);
            let redirectedStdout;
            if (['>', '>>'].includes(args[args.length - 2])) {
                let path = args.pop();
                // Resolve against the current working dir.
                path = new URL(path, `file://${pwd}/`).pathname;
                let { preOpen, relativePath } = openFiles.findRelPath(path);
                let handle = await preOpen.getFileOrDir(relativePath, 1 /* File */, 1 /* Create */);
                if (args.pop() === '>') {
                    redirectedStdout = await handle.createWritable();
                }
                else {
                    redirectedStdout = await handle.createWritable({ keepExistingData: true });
                    redirectedStdout.seek((await handle.getFile()).size);
                }
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
                    stdin,
                    stdout: redirectedStdout ?? stdout,
                    stderr: stdout,
                    args: ['$', ...args],
                    env: {
                        RUST_BACKTRACE: '1',
                        PWD: pwd
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