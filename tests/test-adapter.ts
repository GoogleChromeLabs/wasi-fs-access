import Bindings from '../src/bindings.js';
import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

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

let bindings = new Bindings({
  args,
  env: envVars
});

for (const dir of dirs) {
  await bindings.addPreOpen(dir, dir);
}

const wasmBinary = await readFile(testFile);
const wasmModule = await WebAssembly.compile(wasmBinary);
process.exit(await bindings.run(wasmModule));
