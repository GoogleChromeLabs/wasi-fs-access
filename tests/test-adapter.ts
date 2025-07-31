import * as assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import whyIsNodeRunning from 'why-is-node-running';
import { Miniflare } from 'miniflare';
import { join } from 'node:path';

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

const mf = new Miniflare({
  modules: [
    {
      type: 'ESModule',
      path: 'test-module.mjs',
      contents: await readFile(
        new URL(import.meta.resolve('./test-module.mjs')),
        'utf-8'
      )
    },
    {
      type: 'CompiledWasm',
      path: 'test.wasm',
      contents: await readFile(testFile)
    },
    ...(
      await Promise.all(
        dirs.map(async dir =>
          (await readdir(dir, { recursive: true })).map(file => join(dir, file))
        )
      )
    )
      .flat()
      .map(path => ({
        type: 'Data',
        path
      }))
  ],
  compatibilityDate: '2025-07-26',
  compatibilityFlags: [
    'nodejs_compat',
    'experimental',
    'enable_nodejs_process_v2'
  ]
});

try {
  const res = await mf.dispatchFetch('http://localhost:8787/', {
    method: 'POST',
    body: JSON.stringify({
      args,
      env: envVars,
      dirs
    })
  });

  if (res.ok) {
    process.exitCode = (
      (await res.json()) as { statusCode: number }
    ).statusCode;
  } else {
    throw new Error(await res.text());
  }
} finally {
  await mf.dispose();
}
