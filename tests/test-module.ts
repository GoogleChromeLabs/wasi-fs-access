import Bindings from '../src/bindings.js';
import wasmModule from 'test.wasm';
import { cp } from 'node:fs/promises';

export default {
  async fetch(request: Request) {
    try {
      const { args, env, dirs } = await request.json();

      /*await using*/ const bindings = new Bindings({
        args,
        env,
        abortSignal: request.signal
      });

      for (let dir of dirs) {
        await cp(`/bundle/${dir}`, `/tmp/${dir}`, {
          recursive: true,
          preserveTimestamps: true
        });
        await bindings.addPreOpen(dir, `/tmp/${dir}`);
      }

      return Response.json({ statusCode: await bindings.run(wasmModule) });
    } catch (e) {
      return new Response(e.stack ?? String(e), {
        status: 500
      });
    }
  }
};
