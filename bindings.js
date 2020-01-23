'use strict';
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
const fd_t = uint32_t;
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
const PREOPEN = '/';
const PREOPEN_FD = 3;
export default ({ rootHandle, memory, env, args, writeOut, writeErr, }) => {
    const openFiles = (() => {
        let openFiles = new Map([
            [PREOPEN_FD, { handle: rootHandle, path: '/', position: 0 }]
        ]);
        let nextFd = (PREOPEN_FD + 1);
        async function getFileOrDir(path, mode, create) {
            if (!path.startsWith('/')) {
                throw new Error('Non-absolute path.');
            }
            path = path.slice(1);
            if (!path) {
                if (mode !== 'file') {
                    return rootHandle;
                }
                else {
                    throw new Error('Requested a file, but got root directory.');
                }
            }
            let items = path.split('/');
            let lastItem = items.pop();
            let curDir = rootHandle;
            for (let chunk of items) {
                curDir = await curDir.getDirectory(chunk);
            }
            if (mode === 'file') {
                return curDir.getFile(lastItem, { create });
            }
            else if (mode === 'dir') {
                return curDir.getDirectory(lastItem, { create });
            }
            else {
                try {
                    return await curDir.getFile(lastItem, { create });
                }
                catch {
                    return curDir.getDirectory(lastItem, { create });
                }
            }
        }
        async function open(path) {
            openFiles.set(nextFd, {
                path,
                handle: await getFileOrDir(path, 'fileOrDir', false),
                position: 0,
            });
            return nextFd++;
        }
        return {
            open,
            getFileOrDir,
            get(fd) {
                let file = openFiles.get(fd);
                if (!file) {
                    throw new Error('Tried to retrieve a non-existing file.');
                }
                return file;
            },
            close(fd) {
                if (!openFiles.delete(fd)) {
                    throw new Error('Tried to close a non-existing file.');
                }
            }
        };
    })();
    function resolvePath(dirFd, pathPtr, pathLen) {
        let relativePath = string.get(memory.buffer, pathPtr, pathLen);
        if (relativePath.startsWith('/')) {
            return relativePath;
        }
        let cwdPath = openFiles.get(dirFd).path.slice(1);
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
    async function forEachIoVec(iovsPtr, iovsLen, handledPtr, cb) {
        let totalHandled = 0;
        for (let i = 0; i < iovsLen; i++) {
            let iovec = iovec_t.get(memory.buffer, iovsPtr);
            let buf = new Uint8Array(memory.buffer, iovec.bufPtr, iovec.bufLen);
            let handled = await cb(buf);
            totalHandled += handled;
            if (handled < iovec.bufLen) {
                break;
            }
            iovsPtr = (iovsPtr + iovec_t.size);
        }
        size_t.set(memory.buffer, handledPtr, totalHandled);
    }
    let envOffsets = [];
    let envBuf = '';
    for (let key in env) {
        envOffsets.push(envBuf.length);
        envBuf += `${key}=${env[key]}\0`;
    }
    let argOffsets = [];
    let argBuf = '';
    for (let arg of args) {
        argOffsets.push(argBuf.length);
        argBuf += `${arg}\0`;
    }
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
    let stdout = writeOut ? { write: writeOut } : new StdOut(console.log);
    let stderr = writeErr ? { write: writeErr } : new StdOut(console.error);
    return {
        fd_prestat_get(fd, prestatPtr) {
            if (fd !== PREOPEN_FD) {
                return 8 /* BADF */;
            }
            let prestat = prestat_t.get(memory.buffer, prestatPtr);
            prestat.type = 'dir';
            prestat.nameLen = PREOPEN.length;
        },
        fd_prestat_dir_name(fd, pathPtr, pathLen) {
            if (fd != PREOPEN_FD) {
                return 8 /* BADF */;
            }
            string.set(memory.buffer, pathPtr, PREOPEN, pathLen);
        },
        environ_sizes_get(countPtr, sizePtr) {
            size_t.set(memory.buffer, countPtr, envOffsets.length);
            size_t.set(memory.buffer, sizePtr, envBuf.length);
        },
        environ_get(environPtr, environBufPtr) {
            new Uint32Array(memory.buffer, environPtr, envOffsets.length).set(envOffsets.map(offset => environBufPtr + offset));
            string.set(memory.buffer, environBufPtr, envBuf);
        },
        args_sizes_get(argcPtr, argvBufSizePtr) {
            size_t.set(memory.buffer, argcPtr, argOffsets.length);
            size_t.set(memory.buffer, argvBufSizePtr, argBuf.length);
        },
        args_get(argvPtr, argvBufPtr) {
            new Uint32Array(memory.buffer, argvPtr, argOffsets.length).set(argOffsets.map(offset => argvBufPtr + offset));
            string.set(memory.buffer, argvBufPtr, argBuf);
        },
        proc_exit(code) {
            if (code != 0) {
                stderr.write(new TextEncoder().encode(`Exited with code ${code}.\n`));
            }
            throw EXIT;
        },
        random_get(bufPtr, bufLen) {
            crypto.getRandomValues(new Uint8Array(memory.buffer, bufPtr, bufLen));
        },
        async path_open(dirFd, dirFlags, pathPtr, pathLen, oFlags, fsRightsBase, fsRightsInheriting, fsFlags, fdPtr) {
            fd_t.set(memory.buffer, fdPtr, await openFiles.open(resolvePath(dirFd, pathPtr, pathLen)));
        },
        fd_close(fd) {
            openFiles.close(fd);
        },
        async fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
            let openFile = openFiles.get(fd);
            if (!openFile.handle.isFile) {
                throw new Error('Tried to read a directory.');
            }
            let file = await openFile.handle.getFile();
            await forEachIoVec(iovsPtr, iovsLen, nreadPtr, async (buf) => {
                let blob = file.slice(openFile.position, openFile.position + iovsLen);
                buf.set(new Uint8Array(await blob.arrayBuffer()));
                openFile.position += blob.size;
                return blob.size;
            });
        },
        async fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
            let write;
            let close;
            switch (fd) {
                case 1: {
                    write = async (data) => {
                        await stdout.write(data);
                        return data.length;
                    };
                    break;
                }
                case 2: {
                    write = async (data) => {
                        await stderr.write(data);
                        return data.length;
                    };
                    break;
                }
                default: {
                    let openFile = openFiles.get(fd);
                    if (!openFile.handle.isFile) {
                        throw new Error('Tried to write to a directory.');
                    }
                    let writer = await openFile.handle.createWriter({ keepExistingData: true });
                    write = async (data) => {
                        await writer.write(openFile.position, data);
                        openFile.position += data.length;
                        return data.length;
                    };
                    close = () => writer.close();
                    break;
                }
            }
            await forEachIoVec(iovsPtr, iovsLen, nwrittenPtr, write);
            if (close) {
                await close();
            }
        },
        async fd_fdstat_get(fd, fdstatPtr) {
            let fdstat = fdstat_t.get(memory.buffer, fdstatPtr);
            fdstat.filetype = openFiles.get(fd).handle.isDirectory
                ? 'directory'
                : 'regularFile';
            fdstat.flags = 0;
            fdstat.rightsBase = -1n;
            fdstat.rightsInheriting = -1n;
        },
        async path_create_directory(dirFd, pathPtr, pathLen) {
            await openFiles.getFileOrDir(resolvePath(dirFd, pathPtr, pathLen), 'dir', true);
        },
        async path_rename(oldDirFd, oldPathPtr, oldPathLen, newDirFd, newPathPtr, newPathLen) {
            throw new Error('unimplemented');
        },
        async path_remove_directory(dirFd, pathPtr, pathLen) {
            throw new Error('unimplemented');
        },
        async fd_readdir(fd, bufPtr, bufLen, cookie, bufUsedPtr) {
            const initialBufPtr = bufPtr;
            let openFile = openFiles.get(fd);
            if (!openFile.handle.isDirectory) {
                throw new Error('Tried to iterate a file.');
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
                let dirent = dirent_t.get(memory.buffer, bufPtr);
                dirent.next = ++cookie;
                dirent.ino = 0n; // TODO
                dirent.nameLen = item.name.length;
                dirent.type = item.isDirectory ? 'directory' : 'regularFile';
                string.set(memory.buffer, bufPtr + dirent_t.size, item.name);
                bufPtr = (bufPtr + itemSize);
                bufLen -= itemSize;
            }
            size_t.set(memory.buffer, bufUsedPtr, bufPtr - initialBufPtr);
        },
        path_readlink(dirFd, pathPtr, pathLen, bufPtr, bufLen, bufUsedPtr) {
            throw new Error('unimplemented');
        },
        async path_filestat_get(dirFd, flags, pathPtr, pathLen, filestatPtr) {
            let path = resolvePath(dirFd, pathPtr, pathLen);
            let info = await openFiles.getFileOrDir(path, 'fileOrDir', false);
            let filestat = filestat_t.get(memory.buffer, filestatPtr);
            filestat.dev = 0n;
            filestat.ino = 0n; // TODO
            filestat.filetype = info.isDirectory ? 'directory' : 'regularFile';
            filestat.nlink = 0;
            // https://github.com/DefinitelyTyped/DefinitelyTyped/issues/30471#issuecomment-480900510
            if (info.isFile) {
                let file = await info.getFile();
                filestat.size = BigInt(file.size);
                filestat.accessTime = filestat.modTime = filestat.changeTime = BigInt(file.lastModified) * 1000000n;
            }
            else {
                filestat.size = filestat.accessTime = filestat.modTime = filestat.changeTime = 0n;
            }
        },
        fd_seek(fd, offset, whence, filesizePtr) {
            throw new Error('unimplemented');
        }
    };
};
