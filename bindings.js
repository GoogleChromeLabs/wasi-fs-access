'use strict';

/*
	(import "wasi_unstable" "path_create_directory" (func $path_create_directory (type $t9)))
	(import "wasi_unstable" "path_rename" (func $path_rename (type $t11)))
	(import "wasi_unstable" "path_remove_directory" (func $path_remove_directory (type $t9)))
	(import "wasi_unstable" "fd_readdir" (func $fd_readdir (type $t12)))
	(import "wasi_unstable" "path_readlink" (func $path_readlink (type $t11)))
	(import "wasi_unstable" "path_filestat_get" (func $path_filestat_get (type $t13)))
*/

const fs = require('fs');
const path = require('path');

function std(ctor) {
	return {
		size: ctor.BYTES_PER_ELEMENT,
		get(buf, ptr) {
			return new ctor(buf, ptr, 1)[0];
		},
		set(buf, ptr, value) {
			new ctor(buf, ptr, 1)[0] = value;
		}
	};
}

const i8 = std(Int8Array);
const u8 = std(Uint8Array);
const i16 = std(Int16Array);
const u16 = std(Uint16Array);
const i32 = std(Int32Array);
const u32 = std(Uint32Array);
const i64 = std(BigInt64Array);
const u64 = std(BigUint64Array);
const size = u32;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const string = len => ({
	size: len,
	get(buf, ptr) {
		return textDecoder.decode(new Uint8Array(buf, ptr, len));
	},
	set(buf, ptr, str) {
		let { read } = textEncoder.encodeInto(str, new Uint8Array(buf, ptr, len));
		if (read < str.length) {
			throw new Error(`Insufficient space when writing string ${str} (read ${read}, length ${str.length}, reserved ${len}).`);
		}
	}
});

const struct = desc => {
	let offset = 0;
	for (let name in desc) {
		let type = desc[name];
		let align = type.size;
		let mismatch = offset % align;
		if (mismatch) {
			offset += align - mismatch;
		}
		let storedOffset = offset;
		let getItemPtr = instance => new constructor(instance.buf, instance.ptr + storedOffset, 1);
		Object.defineProperty(Ctor.prototype, name, {
			get() {
				return type.get()
			},
			set(value) {
				getItemPtr(this)[0] = value;
			}
		});
		offset += type.size;
	}
	return
	Ctor.BYTES_PER_ELEMENT = offset;
	return Ctor;
};

function enumer(desc) {
	let base = types[desc.base];
	let Ctor = class {
		constructor(...args) {
			this.inner = new base(...args);
		}

		get 0() {
			let name = desc.variants[this.inner[0]];
			if (name === undefined) {
				throw new TypeError(`Invalid ID ${this.inner[0]}.`);
			}
			return name;
		}

		set 0(name) {
			let id = desc.variants.indexOf(name);
			if (id === -1) {
				throw new TypeError(`Invalid variant ${name}.`);
			}
			this.inner[0] = id;
		}
	};
	Ctor.BYTES_PER_ELEMENT = base.BYTES_PER_ELEMENT;
	return Ctor;
}

types.preopentype = enumer({
	base: 'i8',
	variants: ['dir']
});

types.prestat = struct({
	type: 'preopentype',
	nameLen: 'size'
});

types.fd = types.u32;

types.iovec = struct({
	bufPtr: 'u32',
	bufLen: 'size'
});

types.filetype = enumer({
	base: 'u8',
	variants: [
		'unknown',
		'blockDevice',
		'charDevice',
		'directory',
		'regularFile',
		'socketDgram',
		'socketStream',
		'symbolicLink'
	]
});

types.fdflags = types.u16;

types.rights = types.u64;

types.fdstat = struct({
	filetype: 'filetype',
	flags: 'fdflags',
	rightsBase: 'rights',
	rightsInheriting: 'rights',
});

const PREOPEN = '/sandbox';

const E = {
	SUCCESS: 0,
	BADF: 8
};

const PREOPEN_FD = 3;

let nextFd = PREOPEN_FD;

let openFiles = new Map([
	[0, { fd: 0 }],
	[1, { fd: 1 }],
	[2, { fd: 2 }],
]);

function open(path) {
	openFiles.set(nextFd, {
		path,
		fd: fs.openSync(path)
	});
	return nextFd++;
}

open('.');

module.exports = ({ memory, env, args }) => {
	return {
		fd_prestat_get(fd, prestatPtr) {
			if (fd !== PREOPEN_FD) {
				return E.BADF;
			}
			let prestat = new types.prestat(memory.buffer, prestatPtr);
			prestat.type = 'dir';
			prestat.nameLen = PREOPEN.length;
		},
		fd_prestat_dir_name(fd, pathPtr, pathLen) {
			if (fd != PREOPEN_FD) {
				return E.BADF;
			}
			setString(memory.buffer, pathPtr, pathLen, PREOPEN);
		},
		environ_sizes_get(countPtr, sizePtr) {
			let entries = Object.entries(env);

			new types.size(memory.buffer, countPtr, 1)[0] = entries.length;
			new types.size(memory.buffer, sizePtr, 1)[0] = entries.reduce((acc, [key, value]) => acc + key.length + 1 + value.length + 1, 0);
		},
		environ_get(environPtr, environBufPtr) {
			let entries = Object.entries(env);
			let environ = new types.u32(memory.buffer, environPtr, entries.length);

			for (let [i, [key, value]] of entries.entries()) {
				environ[i] = environBufPtr;

				let entry = `${key}=${value}\0`;
				setString(memory.buffer, environBufPtr, entry.length, entry);

				environBufPtr += entry.length;
			}
		},
		args_sizes_get(argcPtr, argvBufSizePtr) {
			new types.size(memory.buffer, argcPtr, 1)[0] = args.length;
			new types.size(memory.buffer, argvBufSizePtr, 1)[0] = args.reduce((acc, arg) => acc + arg.length + 1, 0);
		},
		args_get(argvPtr, argvBufPtr) {
			let argv = new types.u32(memory.buffer, argvPtr, args.length);

			for (let [i, arg] of args.entries()) {
				arg += '\0';
				argv[i] = argvBufPtr;
				setString(memory.buffer, argvBufPtr, arg.length, arg);
				argvBufPtr += arg.length;
			}
		},
		proc_exit(code) {
			process.exit(code);
		},
		random_get(bufPtr, bufLen) {
			require('crypto').randomFillSync(new Uint8Array(memory.buffer, bufPtr, bufLen));
		},
		path_open(dirFd, dirFlags, pathPtr, pathLen, oFlags, fsRightsBase, fsRightsInheriting, fsFlags, fdPtr) {
			let fullPath = path.resolve(openFiles.get(dirFd).path, getString(memory.buffer, pathPtr, pathLen));
			new types.fd(memory.buffer, fdPtr, 1)[0] = open(fullPath);
		},
		fd_close(fd) {
			openFiles.delete(fd);
		},
		fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
			fd = openFiles.get(fd).fd;
			let nread = new types.size(memory.buffer, nreadPtr, 1);
			nread[0] = 0;
			for (let i = 0; i < iovsLen; i++) {
				let iovec = new types.iovec(memory.buffer, iovsPtr);
				let read = fs.readSync(fd, new Uint8Array(memory.buffer, iovec.bufPtr, iovec.bufLen));
				nread[0] += read;
				if (read < iovec.bufLen) {
					break;
				}
				iovsPtr += types.iovec.BYTES_PER_ELEMENT;
			}
		},
		fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
			fd = openFiles.get(fd).fd;
			let nwritten = new types.size(memory.buffer, nwrittenPtr, 1);
			nwritten[0] = 0;
			for (let i = 0; i < iovsLen; i++) {
				let iovec = new types.iovec(memory.buffer, iovsPtr);
				let written = fs.writeSync(fd, new Uint8Array(memory.buffer, iovec.bufPtr, iovec.bufLen));
				nwritten[0] += written;
				if (written < iovec.bufLen) {
					break;
				}
				iovsPtr += types.iovec.BYTES_PER_ELEMENT;
			}
		},
		fd_fdstat_get(fd, fdstatPtr) {
			let fdstat = new types.fdstat(memory.buffer, fdstatPtr);
			fdstat.filetype = fs.fstatSync(openFiles.get(fd).fd).isDirectory() ? 'directory' : 'regularFile';
			fdstat.flags = 0;
			fdstat.rightsBase = BigInt(-1);
			fdstat.rightsInheriting = BigInt(-1);
		},
		path_create_directory() {},
		path_rename() {},
		path_remove_directory() {},
		fd_readdir() {},
		path_readlink() {},
		path_filestat_get() {},
	}
};
