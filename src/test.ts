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

import Bindings, { stringOut, bufferIn } from './bindings.js';
import { OpenFiles } from './fileSystem.js';

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
    let rootHandle = await showDirectoryPicker();
    let [sandbox, tmp] = await Promise.all([
      rootHandle.getDirectoryHandle('sandbox'),
      rootHandle.getDirectoryHandle('tmp').then(async tmp => {
        let promises = [];
        for await (let name of tmp.keys()) {
          promises.push(tmp.removeEntry(name, { recursive: true }));
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
          try {
            let actualExitCode = await new Bindings({
              openFiles: new OpenFiles({
                '/sandbox': sandbox,
                '/tmp': tmp
              }),
              stdin: bufferIn(textEncoder.encode(stdin)),
              stdout: stringOut(text => (actualStdout += text)),
              stderr: stringOut(text => (actualStderr += text)),
              args: ['foo', '-bar', '--baz=value'],
              env: {
                NODE_PLATFORM: 'win32'
              }
            }).run(await module);
            if (actualExitCode !== exitCode) {
              throw new Error(
                `Expected exit code: ${exitCode}\nActual exit code: ${actualExitCode}`
              );
            }
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
            resultCell.textContent = 'OK';
          } catch (err) {
            let message;
            if (err instanceof WebAssembly.RuntimeError) {
              message = `Wasm failed on \`unreachable\`:\n${actualStderr}`;
            } else {
              message = err.message;
            }
            resultCell.textContent = `NOT OK: ${message}`;
          }
        }
      )
    );
  } finally {
    runBtn.disabled = false;
  }
};

runBtn.disabled = false;
