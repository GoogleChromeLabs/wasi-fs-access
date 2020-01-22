'use strict';

const fs = require('fs').promises;
const createBindings = require('./bindings');

let realMemory;

let memory = {
	get buffer() {
		return realMemory.buffer;
	}
};

let bindings = createBindings({
	memory,
	env: process.env,
	args: process.argv.slice(2)
});

(async () => {
  let buf = await fs.readFile('uutils.wasm');

  let cache = new WeakMap();

  let { instance } = await WebAssembly.instantiate(buf, {
    wasi_unstable: new Proxy(bindings, {
		get(target, name, receiver) {
			let orig = Reflect.get(target, name, receiver);
			let wrapped = cache.get(orig);
			if (wrapped === undefined) {
				wrapped = (...args) => {
					let res = orig.apply(this, args);
					// if (name === 'args_sizes_get') {
					// 	args[0] = new Uint32Array(instance.exports.memory.buffer, args[0], 1)[0];
					// 	args[1] = new Uint32Array(instance.exports.memory.buffer, args[1], 1)[0];
					// }
					// if (name === 'fd_write') {
					// 	let iovecsRaw = new Uint32Array(instance.exports.memory.buffer, args[1], 2 * args[2]);
					// 	let iovecs = [];
					// 	for (let i = 0; i < args[2]; i++) {
					// 		iovecs.push(new Uint8Array(instance.exports.memory.buffer, iovecsRaw[2 * i], iovecsRaw[2 * i + 1]));
					// 	}
					// 	args = [...iovecs, new Uint32Array(instance.exports.memory.buffer, args[args.length - 1], 1)[0]];
					// }
					// console.log({
					// 	name,
					// 	args,
					// 	res
					// });
					return res;
				};
				cache.set(orig, wrapped);
			}
			return wrapped;
		}
	})
  });

  realMemory = instance.exports.memory;

  instance.exports._start();
})();
