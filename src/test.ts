import Bindings, { stringOut, bufferIn, ExitStatus } from './bindings.js';

// @ts-ignore
import * as Asyncify from '../node_modules/asyncify-wasm/dist/asyncify.mjs';

const EOL = '\n';

type Test = Partial<{
  exitCode: number;
  stdin: string;
  stdout: string;
}>;

const tests: (Test & { test: string })[] = [
  { test: 'cant_dotdot' },
  { test: 'clock_getres' },
  { test: 'exitcode', exitCode: 120 },
  { test: 'fd_prestat_get_refresh' },
  { test: 'freopen', stdout: `hello from input2.txt${EOL}` },
  { test: 'getentropy' },
  { test: 'getrusage' },
  { test: 'gettimeofday' },
  { test: 'link' },
  { test: 'main_args' },
  { test: 'notdir' },
  { test: 'poll' },
  { test: 'preopen_populates' },
  { test: 'read_file', stdout: `hello from input.txt${EOL}` },
  {
    test: 'read_file_twice',
    stdout: `hello from input.txt${EOL}hello from input.txt${EOL}`
  },
  { test: 'stat' },
  { test: 'write_file' },
  { test: 'stdin', stdin: 'hello world', stdout: 'hello world' }
];

let table = document.getElementById('tests-table') as HTMLTableElement;

let preparedTests: (Test & {
  module: Promise<WebAssembly.Module>;
  resultCell: HTMLTableDataCellElement;
})[] = tests.map(({ test, ...expect }) => {
  let module = WebAssembly.compileStreaming(
    fetch(`tests/async-wasm/${test}.wasm`)
  );
  let resultCell = Object.assign(document.createElement('td'), {
    textContent: 'NOT RUN'
  });
  let row = table.insertRow();
  row.insertCell().textContent = test;
  row.appendChild(resultCell);
  return {
    ...expect,
    module,
    resultCell
  };
});

let runBtn = document.getElementById('run-btn') as HTMLButtonElement;

const textEncoder = new TextEncoder();

runBtn.onclick = async () => {
  runBtn.disabled = true;
  try {
    let rootHandle = await chooseFileSystemEntries({
      type: 'open-directory'
    });
    let [sandbox, tmp] = await Promise.all([
      rootHandle.getDirectory('sandbox'),
      rootHandle.getDirectory('tmp').then(async tmp => {
        let promises = [];
        for await (let entry of tmp.getEntries()) {
          promises.push(tmp.removeEntry(entry.name, { recursive: true }));
        }
        await Promise.all(promises);
        return tmp;
      })
    ]);
    await Promise.allSettled(
      preparedTests.map(
        async ({ module, resultCell, stdin, stdout = '', exitCode = 0 }) => {
          resultCell.textContent = 'Running... ';
          let actualStdout = '';
          let actualStderr = '';
          let actualExitCode;
          try {
            try {
              let bindings = new Bindings({
                preOpen: {
                  '/sandbox': sandbox,
                  '/tmp': tmp
                },
                stdin: bufferIn(textEncoder.encode(stdin)),
                stdout: stringOut(text => (actualStdout += text)),
                stderr: stringOut(text => (actualStderr += text)),
                args: ['foo', '-bar', '--baz=value'],
                env: {
                  NODE_PLATFORM: 'win32'
                }
              });
              let {
                exports: { _start, memory }
              } = await Asyncify.instantiate(await module, {
                wasi_snapshot_preview1: bindings.getWasiImports()
              });
              bindings.memory = memory;
              await _start();
              actualExitCode = 0;
              if (actualStdout !== stdout) {
                throw new Error(
                  `Expected stdout: ${JSON.stringify(
                    stdout
                  )}\nActual stdout: ${JSON.stringify(actualStdout)}`
                );
              }
              if (actualStderr !== '') {
                throw new Error(
                  `Unexpected stderr: ${JSON.stringify(actualStderr)}`
                );
              }
            } catch (err) {
              if (err instanceof ExitStatus) {
                actualExitCode = err.statusCode;
              } else if (err instanceof WebAssembly.RuntimeError) {
                throw new Error(actualStderr || 'Wasm failed');
              } else {
                throw err;
              }
            }
            if (actualExitCode !== exitCode) {
              throw new Error(
                `Expected exit code: ${exitCode}\nActual exit code: ${actualExitCode}`
              );
            }
            resultCell.textContent = 'OK';
          } catch (err) {
            resultCell.textContent = `NOT OK: ${err.stack}`;
          }
        }
      )
    );
  } finally {
    runBtn.disabled = false;
  }
};

runBtn.disabled = false;
