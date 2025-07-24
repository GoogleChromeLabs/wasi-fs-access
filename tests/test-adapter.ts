import Bindings from '../src/bindings.js';
import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import whyIsNodeRunning from 'why-is-node-running';

const {
  values: { version, 'test-file': testFile, arg: args, env: envVars, dir: dirs }
} = parseArgs({
  options: {
    version: {
      type: 'boolean',
      short: 'v',
      default: false
    },
    'test-file': {
      type: 'string'
    },
    arg: {
      type: 'string',
      multiple: true,
      default: []
    },
    env: {
      type: 'string',
      multiple: true,
      default: []
    },
    dir: {
      type: 'string',
      multiple: true,
      default: []
    }
  }
});

if (version) {
  const { name, version } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf-8')
  );
  console.log(`${name} v${version}`);
  process.exit(0);
}

assert.ok(testFile, 'Test file must be specified with --test-file');

// Prevent hanging tests.
const abortSignal = AbortSignal.timeout(5_000);

abortSignal.addEventListener('abort', () => {
  whyIsNodeRunning();
  throw abortSignal.reason;
});

await using bindings = new Bindings({
  args,
  env: envVars,
  abortSignal
});

for (const dir of dirs) {
  await bindings.addPreOpen(dir, dir);
}

const wasmBinary = await readFile(testFile);
const wasmModule = await WebAssembly.compile(wasmBinary);
// Note: not using `process.exit()` so that we can catch tests that hang the event loop.
// Apps must be able to exit naturally.
process.exitCode = await bindings.run(wasmModule);
