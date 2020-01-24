import Bindings, { EXIT } from './bindings.js';
// @ts-ignore
import * as Asyncify from './node_modules/asyncify-wasm/dist/asyncify.mjs';
const wasmModule = WebAssembly.compileStreaming(fetch('./uutils.async.wasm'));
document.getElementById('openDir').addEventListener('click', async () => {
    let rootHandle = await chooseFileSystemEntries({ type: 'openDirectory' });
    let term = new Terminal();
    term.open(document.getElementById('terminal'));
    function prompt() {
        term.write('$ ');
    }
    prompt();
    const stdout = {
        async write(data) {
            let startIndex = 0;
            let newLine;
            while ((newLine = data.indexOf(10, startIndex)) !== -1) {
                await new Promise(resolve => term.writeln(data.subarray(startIndex, newLine), resolve));
                startIndex = newLine + 1;
            }
            await new Promise(resolve => term.write(data.subarray(startIndex), resolve));
        }
    };
    let args = '';
    term.onKey(async (e) => {
        const printable = !e.domEvent.altKey && !e.domEvent.ctrlKey && !e.domEvent.metaKey;
        if (e.domEvent.keyCode === 13) {
            term.writeln('');
            try {
                let bindings = new Bindings({
                    rootHandle,
                    stdout,
                    stderr: stdout,
                    args: args.split(' ')
                });
                let { exports } = await Asyncify.instantiate(await wasmModule, {
                    wasi_unstable: bindings.getWasiImports()
                });
                bindings.memory = exports.memory;
                args = '';
                await exports._start();
            }
            catch (e) {
                if (e !== EXIT) {
                    term.writeln(e.message);
                }
            }
            prompt();
        }
        else if (printable) {
            term.write(e.key);
            args += e.key;
        }
    });
});
