import Bindings, { ExitStatus } from './bindings.js';

// @ts-ignore
import * as Asyncify from '../node_modules/asyncify-wasm/dist/asyncify.mjs';

const wasmModule = WebAssembly.compileStreaming(fetch('./uutils.async.wasm'));

declare const Terminal: typeof import('xterm').Terminal;

document.getElementById('openDir')!.addEventListener('click', async () => {
  let rootHandle = await chooseFileSystemEntries({ type: 'open-directory' });

  let term = new Terminal();
  term.open(document.getElementById('terminal')!);
  function prompt() {
    term.write('$ ');
  }
  prompt();

  const stdout = {
    async write(data: Uint8Array) {
      let startIndex = 0;
      let newLine: number;
      while ((newLine = data.indexOf(10, startIndex)) !== -1) {
        await new Promise(resolve =>
          term.writeln(data.subarray(startIndex, newLine), resolve)
        );
        startIndex = newLine + 1;
      }
      await new Promise(resolve =>
        term.write(data.subarray(startIndex), resolve)
      );
    }
  };

  let args = '';
  term.onKey(async e => {
    const printable =
      !e.domEvent.altKey && !e.domEvent.ctrlKey && !e.domEvent.metaKey;

    if (e.domEvent.keyCode === 13) {
      term.writeln('');
      try {
        let bindings = new Bindings({
          preOpen: {
            '/sandbox': await rootHandle.getDirectory('sandbox'),
            '/tmp': await rootHandle.getDirectory('tmp')
          },
          stdout,
          stderr: stdout,
          args: args.split(' '),
          env: {
            RUST_BACKTRACE: '1'
          }
        });
        let { exports } = await Asyncify.instantiate(await wasmModule, {
          env: {
            sync() {
              throw new Error('unreachable');
            }
          },
          wasi_unstable: bindings.getWasiImports()
        });
        bindings.memory = exports.memory;
        args = '';
        await exports._start();
      } catch (err) {
        if (err instanceof ExitStatus) {
          if (err.statusCode !== 0) {
            term.writeln(`Exit code: ${err.statusCode}`);
          }
        } else {
          term.writeln(err.message);
        }
      }
      prompt();
    } else if (printable) {
      term.write(e.key);
      args += e.key;
    }
  });
});
