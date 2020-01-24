import { OpenFiles, PREOPEN_FD, PREOPEN } from './fileSystem.js';
export const EXIT = Symbol();
const getDataView = (() => {
    const cache = new WeakMap();
    return (buf) => {
        let dataView = cache.get(buf);
        if (!dataView) {
            dataView = new DataView(buf);
            cache.set(buf, dataView);
        }
        return dataView;
    };
})();
function std(name, size) {
    let get = DataView.prototype[`get${name}`];
    let set = DataView.prototype[`set${name}`];
    return {
        size,
        align: size,
        get(buf, ptr) {
            return get.call(getDataView(buf), ptr, true);
        },
        set(buf, ptr, value) {
            return set.call(getDataView(buf), ptr, value, true);
        }
    };
}
const string = (() => {
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();
    return {
        get(buf, ptr, len) {
            return textDecoder.decode(new Uint8Array(buf, ptr, len));
        },
        set(buf, ptr, value, len = value.length) {
            let { read } = textEncoder.encodeInto(value, new Uint8Array(buf, ptr, len));
            if (read < value.length) {
                throw new Error(`Insufficient space.`);
            }
        }
    };
})();
function alignTo(ptr, align) {
    let mismatch = ptr % align;
    if (mismatch) {
        ptr += align - mismatch;
    }
    return ptr;
}
function struct(desc) {
    class Ctor {
        constructor(_buf, _ptr) {
            this._buf = _buf;
            this._ptr = _ptr;
        }
    }
    let offset = 0;
    let structAlign = 0;
    for (let name in desc) {
        let type = desc[name];
        let fieldAlign = type.align;
        structAlign = Math.max(structAlign, fieldAlign);
        offset = alignTo(offset, fieldAlign);
        const fieldOffset = offset;
        Object.defineProperty(Ctor.prototype, name, {
            get() {
                return type.get(this._buf, (this._ptr + fieldOffset));
            },
            set(value) {
                type.set(this._buf, (this._ptr + fieldOffset), value);
            }
        });
        offset += type.size;
    }
    offset = alignTo(offset, structAlign);
    return {
        size: offset,
        align: structAlign,
        get(buf, ptr) {
            return new Ctor(buf, ptr);
        }
    };
}
function enumer(desc) {
    return {
        size: desc.base.size,
        align: desc.base.align,
        get(buf, ptr) {
            let id = desc.base.get(buf, ptr);
            let name = desc.variants[id];
            if (name === undefined) {
                throw new TypeError(`Invalid ID ${id}.`);
            }
            return name;
        },
        set(buf, ptr, value) {
            let id = desc.variants.indexOf(value);
            if (id === -1) {
                throw new TypeError(`Invalid variant ${value}.`);
            }
            desc.base.set(buf, ptr, id);
        }
    };
}
const int8_t = std('Int8', 1);
const uint8_t = std('Uint8', 1);
const int16_t = std('Int16', 2);
const uint16_t = std('Uint16', 2);
const int32_t = std('Int32', 4);
const uint32_t = std('Uint32', 4);
const int64_t = std('bigint64', 8);
const uint64_t = std('BigUint64', 8);
const size_t = uint32_t;
const preopentype_t = enumer({
    base: int8_t,
    variants: ['dir']
});
const prestat_t = struct({
    type: preopentype_t,
    nameLen: size_t
});
export const fd_t = uint32_t;
const iovec_t = struct({
    bufPtr: uint32_t,
    bufLen: size_t
});
const filetype_t = enumer({
    base: uint8_t,
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
const fdflags_t = uint16_t;
const rights_t = uint64_t;
const fdstat_t = struct({
    filetype: filetype_t,
    flags: fdflags_t,
    rightsBase: rights_t,
    rightsInheriting: rights_t
});
const dircookie_t = uint64_t;
const inode_t = uint64_t;
const dirent_t = struct({
    next: dircookie_t,
    ino: inode_t,
    nameLen: uint32_t,
    type: filetype_t
});
const device_t = uint64_t;
const linkcount_t = uint32_t;
const filesize_t = uint64_t;
const timestamp_t = uint64_t;
const filestat_t = struct({
    dev: device_t,
    ino: inode_t,
    filetype: filetype_t,
    nlink: linkcount_t,
    size: filesize_t,
    accessTime: timestamp_t,
    modTime: timestamp_t,
    changeTime: timestamp_t
});
class StdOut {
    constructor(writeLn) {
        this.writeLn = writeLn;
        this._buffer = '';
        this._decoder = new TextDecoder();
    }
    write(data) {
        let lines = (this._buffer + this._decoder.decode(data, { stream: true })).split('\n');
        this._buffer = lines.pop();
        for (let line of lines) {
            this.writeLn(line);
        }
    }
}
export default class Bindings {
    constructor({ rootHandle, stdout = new StdOut(console.log), stderr = new StdOut(console.error), args = [], env = {} }) {
        this._openFiles = new OpenFiles(rootHandle);
        // Set args.
        {
            this._argOffsets = new Uint32Array(args.length);
            this._argBuf = '';
            for (let [i, arg] of args.entries()) {
                this._argOffsets[i] = this._argBuf.length;
                this._argBuf += `${arg}\0`;
            }
        }
        // Set env.
        {
            let pairs = Object.entries(env);
            this._envOffsets = new Uint32Array(pairs.length);
            this._envBuf = '';
            for (let [i, [key, value]] of pairs.entries()) {
                this._envOffsets[i] = this._envBuf.length;
                this._envBuf += `${key}=${value}\0`;
            }
        }
        this._stdOut = stdout;
        this._stdErr = stderr;
    }
    _getBuffer() {
        let { memory } = this;
        if (!memory) {
            throw new Error('Memory not yet initialised.');
        }
        return memory.buffer;
    }
    getWasiImports() {
        return {
            fd_prestat_get: (fd, prestatPtr) => {
                if (fd !== PREOPEN_FD) {
                    return 8 /* BADF */;
                }
                let prestat = prestat_t.get(this._getBuffer(), prestatPtr);
                prestat.type = 'dir';
                prestat.nameLen = PREOPEN.length;
            },
            fd_prestat_dir_name: (fd, pathPtr, pathLen) => {
                if (fd != PREOPEN_FD) {
                    return 8 /* BADF */;
                }
                string.set(this._getBuffer(), pathPtr, PREOPEN, pathLen);
            },
            environ_sizes_get: (countPtr, sizePtr) => {
                size_t.set(this._getBuffer(), countPtr, this._envOffsets.length);
                size_t.set(this._getBuffer(), sizePtr, this._envBuf.length);
            },
            environ_get: (environPtr, environBufPtr) => {
                new Uint32Array(this._getBuffer(), environPtr, this._envOffsets.length).set(this._envOffsets.map(offset => environBufPtr + offset));
                string.set(this._getBuffer(), environBufPtr, this._envBuf);
            },
            args_sizes_get: (argcPtr, argvBufSizePtr) => {
                size_t.set(this._getBuffer(), argcPtr, this._argOffsets.length);
                size_t.set(this._getBuffer(), argvBufSizePtr, this._argBuf.length);
            },
            args_get: (argvPtr, argvBufPtr) => {
                new Uint32Array(this._getBuffer(), argvPtr, this._argOffsets.length).set(this._argOffsets.map(offset => argvBufPtr + offset));
                string.set(this._getBuffer(), argvBufPtr, this._argBuf);
            },
            proc_exit: (code) => {
                if (code != 0) {
                    this._stdErr.write(new TextEncoder().encode(`Exited with code ${code}.\n`));
                }
                throw EXIT;
            },
            random_get: (bufPtr, bufLen) => {
                crypto.getRandomValues(new Uint8Array(this._getBuffer(), bufPtr, bufLen));
            },
            path_open: async (dirFd, dirFlags, pathPtr, pathLen, oFlags, fsRightsBase, fsRightsInheriting, fsFlags, fdPtr) => {
                fd_t.set(this._getBuffer(), fdPtr, await this._openFiles.open(this._resolvePath(dirFd, pathPtr, pathLen)));
            },
            fd_close: (fd) => {
                this._openFiles.close(fd);
            },
            fd_read: async (fd, iovsPtr, iovsLen, nreadPtr) => {
                let openFile = this._openFiles.get(fd);
                if (!openFile.handle.isFile) {
                    return 31 /* ISDIR */;
                }
                let file = await openFile.handle.getFile();
                await this._forEachIoVec(iovsPtr, iovsLen, nreadPtr, async (buf) => {
                    let blob = file.slice(openFile.position, openFile.position + iovsLen);
                    buf.set(new Uint8Array(await blob.arrayBuffer()));
                    openFile.position += blob.size;
                    return blob.size;
                });
            },
            fd_write: async (fd, iovsPtr, iovsLen, nwrittenPtr) => {
                let write;
                let close;
                switch (fd) {
                    case 1: {
                        write = async (data) => {
                            await this._stdOut.write(data);
                            return data.length;
                        };
                        break;
                    }
                    case 2: {
                        write = async (data) => {
                            await this._stdErr.write(data);
                            return data.length;
                        };
                        break;
                    }
                    default: {
                        let openFile = this._openFiles.get(fd);
                        if (!openFile.handle.isFile) {
                            return 31 /* ISDIR */;
                        }
                        let writer = await openFile.handle.createWriter({
                            keepExistingData: true
                        });
                        write = async (data) => {
                            await writer.write(openFile.position, data);
                            openFile.position += data.length;
                            return data.length;
                        };
                        close = () => writer.close();
                        break;
                    }
                }
                await this._forEachIoVec(iovsPtr, iovsLen, nwrittenPtr, write);
                if (close) {
                    await close();
                }
            },
            fd_fdstat_get: async (fd, fdstatPtr) => {
                let fdstat = fdstat_t.get(this._getBuffer(), fdstatPtr);
                fdstat.filetype = this._openFiles.get(fd).handle.isDirectory
                    ? 'directory'
                    : 'regularFile';
                fdstat.flags = 0;
                fdstat.rightsBase = -1n;
                fdstat.rightsInheriting = -1n;
            },
            path_create_directory: async (dirFd, pathPtr, pathLen) => {
                await this._openFiles.getFileOrDir(this._resolvePath(dirFd, pathPtr, pathLen), 'dir', true);
            },
            path_rename: async (oldDirFd, oldPathPtr, oldPathLen, newDirFd, newPathPtr, newPathLen) => {
                return 52 /* NOSYS */;
            },
            path_remove_directory: (dirFd, pathPtr, pathLen) => {
                return 52 /* NOSYS */;
            },
            fd_readdir: async (fd, bufPtr, bufLen, cookie, bufUsedPtr) => {
                const initialBufPtr = bufPtr;
                let openFile = this._openFiles.get(fd);
                if (!openFile.handle.isDirectory) {
                    return 54 /* NOTDIR */;
                }
                let counter = 0n;
                for await (let item of openFile.handle.getEntries()) {
                    if (counter++ < cookie) {
                        continue;
                    }
                    let itemSize = dirent_t.size + item.name.length;
                    if (bufLen < itemSize) {
                        break;
                    }
                    let dirent = dirent_t.get(this._getBuffer(), bufPtr);
                    dirent.next = ++cookie;
                    dirent.ino = 0n; // TODO
                    dirent.nameLen = item.name.length;
                    dirent.type = item.isDirectory ? 'directory' : 'regularFile';
                    string.set(this._getBuffer(), (bufPtr + dirent_t.size), item.name);
                    bufPtr = (bufPtr + itemSize);
                    bufLen -= itemSize;
                }
                size_t.set(this._getBuffer(), bufUsedPtr, bufPtr - initialBufPtr);
            },
            path_readlink(dirFd, pathPtr, pathLen, bufPtr, bufLen, bufUsedPtr) {
                return 52 /* NOSYS */;
            },
            path_filestat_get: async (dirFd, flags, pathPtr, pathLen, filestatPtr) => {
                let path = this._resolvePath(dirFd, pathPtr, pathLen);
                let info = await this._openFiles.getFileOrDir(path, 'fileOrDir', false);
                let filestat = filestat_t.get(this._getBuffer(), filestatPtr);
                filestat.dev = 0n;
                filestat.ino = 0n; // TODO
                filestat.filetype = info.isDirectory ? 'directory' : 'regularFile';
                filestat.nlink = 0;
                // https://github.com/DefinitelyTyped/DefinitelyTyped/issues/30471#issuecomment-480900510
                if (info.isFile) {
                    let file = await info.getFile();
                    filestat.size = BigInt(file.size);
                    filestat.accessTime = filestat.modTime = filestat.changeTime =
                        BigInt(file.lastModified) * 1000000n;
                }
                else {
                    filestat.size = filestat.accessTime = filestat.modTime = filestat.changeTime = 0n;
                }
            },
            fd_seek: (fd, offset, whence, filesizePtr) => {
                return 52 /* NOSYS */;
            }
        };
    }
    _resolvePath(dirFd, pathPtr, pathLen) {
        let relativePath = string.get(this._getBuffer(), pathPtr, pathLen);
        if (relativePath.startsWith('/')) {
            return relativePath;
        }
        let cwdPath = this._openFiles.get(dirFd).path.slice(1);
        let cwdParts = cwdPath ? cwdPath.split('/') : [];
        for (let item of relativePath.split('/')) {
            if (item === '..') {
                cwdParts.pop();
            }
            else if (item !== '.') {
                cwdParts.push(item);
            }
        }
        return '/' + cwdParts.join('/');
    }
    async _forEachIoVec(iovsPtr, iovsLen, handledPtr, cb) {
        let totalHandled = 0;
        for (let i = 0; i < iovsLen; i++) {
            let iovec = iovec_t.get(this._getBuffer(), iovsPtr);
            let buf = new Uint8Array(this._getBuffer(), iovec.bufPtr, iovec.bufLen);
            let handled = await cb(buf);
            totalHandled += handled;
            if (handled < iovec.bufLen) {
                break;
            }
            iovsPtr = (iovsPtr + iovec_t.size);
        }
        size_t.set(this._getBuffer(), handledPtr, totalHandled);
    }
}
