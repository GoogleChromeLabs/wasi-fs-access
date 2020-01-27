import Bindings, { EXIT } from './bindings.js';

// @ts-ignore
import * as Asyncify from './node_modules/asyncify-wasm/dist/asyncify.mjs';

const wasmModule = WebAssembly.compileStreaming(fetch('./uutils.async.wasm'));

declare const Terminal: typeof import('xterm').Terminal;

document.getElementById('openDir')!.addEventListener('click', async () => {
  let rootHandle = await chooseFileSystemEntries({ type: 'openDirectory' });

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
          rootHandle,
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
              throw new Error('Tried to call env.sync.');
            }
          },
          wasi_unstable: new Proxy(bindings.getWasiImports(), {
            get(target: any, key) {
              let f = target[key];
              if (!f) {
                return f;
              }
              return async (...args: any[]) => {
                let res = await f(...args);
                console.log({ key, args, res });
                return res;
              };
            }
          })
        });
        bindings.memory = exports.memory;
        let logLine = args;
        args = '';
        console.time(logLine);
        try {
          await exports._start();
        } finally {
          console.timeEnd(logLine);
        }
      } catch (e) {
        if (e !== EXIT) {
          term.writeln(e.message);
        }
      }
      prompt();
    } else if (printable) {
      term.write(e.key);
      args += e.key;
    }
  });
});
