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
import { FIRST_PREOPEN_FD } from './fileSystem.js';
// @ts-ignore
import { instantiate } from '../node_modules/asyncify-wasm/dist/asyncify.mjs';
export var E;
(function (E) {
    E[E["SUCCESS"] = 0] = "SUCCESS";
    E[E["ACCES"] = 2] = "ACCES";
    E[E["BADF"] = 8] = "BADF";
    E[E["CANCELED"] = 11] = "CANCELED";
    E[E["EXIST"] = 20] = "EXIST";
    E[E["INVAL"] = 28] = "INVAL";
    E[E["ISDIR"] = 31] = "ISDIR";
    E[E["NOENT"] = 44] = "NOENT";
    E[E["NOSYS"] = 52] = "NOSYS";
    E[E["NOTDIR"] = 54] = "NOTDIR";
    E[E["NOTEMPTY"] = 55] = "NOTEMPTY";
    E[E["NOTCAPABLE"] = 76] = "NOTCAPABLE";
})(E || (E = {}));
export class ExitStatus {
    constructor(statusCode) {
        this.statusCode = statusCode;
    }
}
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
        },
        set(buf, ptr, value) {
            Object.assign(new Ctor(buf, ptr), value);
        }
    };
}
function taggedUnion({ tag: tagDesc, data: dataDesc }) {
    let unionSize = 0;
    let unionAlign = 0;
    for (let key in dataDesc) {
        let { size, align } = dataDesc[key];
        unionSize = Math.max(unionSize, size);
        unionAlign = Math.max(unionAlign, align);
    }
    unionSize = alignTo(unionSize, unionAlign);
    const unionOffset = alignTo(tagDesc.size, unionAlign);
    const totalAlign = Math.max(tagDesc.align, unionAlign);
    const totalSize = alignTo(unionOffset + unionSize, totalAlign);
    return {
        size: totalSize,
        align: totalAlign,
        get(buf, ptr) {
            let tag = tagDesc.get(buf, ptr);
            return {
                tag,
                data: dataDesc[tag].get(buf, (ptr + unionOffset))
            };
        },
        set(buf, ptr, value) {
            tagDesc.set(buf, ptr, value.tag);
            dataDesc[value.tag].set(buf, (ptr + unionOffset), value.data);
        }
    };
}
function enumer(base) {
    // All the properties are same as for the underlying number, this wrapper is only useful at typechecking level.
    return base;
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
const preopentype_t = enumer(int8_t);
const prestat_t = struct({
    type: preopentype_t,
    nameLen: size_t
});
export const fd_t = uint32_t;
const iovec_t = struct({
    bufPtr: uint32_t,
    bufLen: size_t
});
const filetype_t = enumer(uint8_t);
const fdflags_t = enumer(uint16_t);
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
const linkcount_t = uint64_t;
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
const clockid_t = enumer(uint32_t);
const userdata_t = uint64_t;
const eventtype_t = enumer(uint8_t);
const subclockflags_t = enumer(uint16_t);
const subscription_clock_t = struct({
    id: clockid_t,
    timeout: timestamp_t,
    precision: timestamp_t,
    flags: subclockflags_t
});
const subscription_fd_readwrite_t = struct({
    fd: fd_t
});
const subscription_union_t = taggedUnion({
    tag: eventtype_t,
    data: {
        [0 /* Clock */]: subscription_clock_t,
        [1 /* FdRead */]: subscription_fd_readwrite_t,
        [2 /* FdWrite */]: subscription_fd_readwrite_t
    }
});
const subscription_t = struct({
    userdata: userdata_t,
    union: subscription_union_t
});
const event_rw_flags_t = enumer(uint16_t);
const event_fd_readwrite_t = struct({
    nbytes: filesize_t,
    flags: event_rw_flags_t
});
const event_t = struct({
    userdata: userdata_t,
    error: enumer(uint16_t),
    type: eventtype_t,
    fd_readwrite: event_fd_readwrite_t
});
export class SystemError extends Error {
    constructor(code) {
        super(`E${E[code]}`);
        this.code = code;
    }
}
export const bufferIn = (buffer) => {
    return {
        read: len => {
            let chunk = buffer.subarray(0, len);
            buffer = buffer.subarray(len);
            return chunk;
        }
    };
};
export const stringOut = (writeStr) => {
    let decoder = new TextDecoder();
    return {
        write: data => {
            writeStr(decoder.decode(data, { stream: true }));
        }
    };
};
export const lineOut = (writeLn) => {
    let lineBuf = '';
    return stringOut(chunk => {
        lineBuf += chunk;
        let lines = lineBuf.split('\n');
        lineBuf = lines.pop();
        for (let line of lines) {
            writeLn(line);
        }
    });
};
function unimplemented() {
    throw new SystemError(E.NOSYS);
}
class StringCollection {
    constructor(strings) {
        this._offsets = new Uint32Array(strings.length);
        this._buffer = '';
        for (let [i, s] of strings.entries()) {
            this._offsets[i] = this._buffer.length;
            this._buffer += `${s}\0`;
        }
    }
    sizes_get(buf, countPtr, sizePtr) {
        size_t.set(buf, countPtr, this._offsets.length);
        size_t.set(buf, sizePtr, this._buffer.length);
    }
    get(buf, offsetsPtr, ptr) {
        new Uint32Array(buf, offsetsPtr, this._offsets.length).set(this._offsets.map(offset => ptr + offset));
        string.set(buf, ptr, this._buffer);
    }
}
export default class Bindings {
    constructor({ openFiles, stdin = { read: () => new Uint8Array() }, stdout = lineOut(console.log), stderr = lineOut(console.error), args = [], env = {} }) {
        this._openFiles = openFiles;
        this._stdIn = stdin;
        this._stdOut = stdout;
        this._stdErr = stderr;
        this._args = new StringCollection(['uutils', ...args]);
        this._env = new StringCollection(Object.entries(env).map(([key, value]) => `${key}=${value}`));
    }
    _getBuffer() {
        let { memory } = this;
        if (!memory) {
            throw new Error('Memory not yet initialised.');
        }
        return memory.buffer;
    }
    _getFileStat(file, filestatPtr) {
        let size = 0n;
        let time = 0n;
        if (file) {
            size = BigInt(file.size);
            time = BigInt(file.lastModified) * 1000000n;
        }
        filestat_t.set(this._getBuffer(), filestatPtr, {
            dev: 0n,
            ino: 0n,
            filetype: file ? 4 /* RegularFile */ : 3 /* Directory */,
            nlink: 0n,
            size,
            accessTime: time,
            modTime: time,
            changeTime: time
        });
    }
    getWasiImports() {
        const bindings = {
            fd_prestat_get: (fd, prestatPtr) => {
                prestat_t.set(this._getBuffer(), prestatPtr, {
                    type: 0 /* Dir */,
                    nameLen: this._openFiles.getPreOpen(fd).path.length
                });
            },
            fd_prestat_dir_name: (fd, pathPtr, pathLen) => {
                string.set(this._getBuffer(), pathPtr, this._openFiles.getPreOpen(fd).path, pathLen);
            },
            environ_sizes_get: (countPtr, sizePtr) => this._env.sizes_get(this._getBuffer(), countPtr, sizePtr),
            environ_get: (environPtr, environBufPtr) => this._env.get(this._getBuffer(), environPtr, environBufPtr),
            args_sizes_get: (argcPtr, argvBufSizePtr) => this._args.sizes_get(this._getBuffer(), argcPtr, argvBufSizePtr),
            args_get: (argvPtr, argvBufPtr) => this._args.get(this._getBuffer(), argvPtr, argvBufPtr),
            proc_exit: (code) => {
                throw new ExitStatus(code);
            },
            random_get: (bufPtr, bufLen) => {
                crypto.getRandomValues(new Uint8Array(this._getBuffer(), bufPtr, bufLen));
            },
            path_open: async (dirFd, dirFlags, pathPtr, pathLen, oFlags, fsRightsBase, fsRightsInheriting, fsFlags, fdPtr) => {
                if (fsFlags & 4 /* NonBlock */) {
                    console.warn('Asked for non-blocking mode while opening the file, falling back to blocking one.');
                    fsFlags &= ~4 /* NonBlock */;
                }
                if (fsFlags != 0) {
                    unimplemented();
                }
                fd_t.set(this._getBuffer(), fdPtr, await this._openFiles.open(this._openFiles.getPreOpen(dirFd), string.get(this._getBuffer(), pathPtr, pathLen), oFlags));
            },
            fd_fdstat_set_flags: (fd, flags) => unimplemented(),
            fd_close: (fd) => this._openFiles.close(fd),
            fd_read: async (fd, iovsPtr, iovsLen, nreadPtr) => {
                let input = fd === 0 ? this._stdIn : this._openFiles.get(fd).asFile();
                await this._forEachIoVec(iovsPtr, iovsLen, nreadPtr, async (buf) => {
                    let chunk = await input.read(buf.length);
                    buf.set(chunk);
                    return chunk.length;
                });
            },
            fd_write: async (fd, iovsPtr, iovsLen, nwrittenPtr) => {
                let out;
                switch (fd) {
                    case 1: {
                        out = this._stdOut;
                        break;
                    }
                    case 2: {
                        out = this._stdErr;
                        break;
                    }
                    default: {
                        out = this._openFiles.get(fd).asFile();
                        break;
                    }
                }
                await this._forEachIoVec(iovsPtr, iovsLen, nwrittenPtr, async (data) => {
                    await out.write(data);
                    return data.length;
                });
            },
            fd_fdstat_get: async (fd, fdstatPtr) => {
                let filetype;
                if (fd < FIRST_PREOPEN_FD) {
                    filetype = 2 /* CharacterDevice */;
                }
                else if (this._openFiles.get(fd).isFile) {
                    filetype = 4 /* RegularFile */;
                }
                else {
                    filetype = 3 /* Directory */;
                }
                fdstat_t.set(this._getBuffer(), fdstatPtr, {
                    filetype,
                    flags: 0,
                    rightsBase: /* anything */ -1n,
                    rightsInheriting: /* anything but symlink */ ~(1n << 24n)
                });
            },
            path_create_directory: async (dirFd, pathPtr, pathLen) => this._openFiles
                .getPreOpen(dirFd)
                .getFileOrDir(string.get(this._getBuffer(), pathPtr, pathLen), 2 /* Dir */, 1 /* Create */ | 2 /* Directory */ | 4 /* Exclusive */)
                .then(() => { }),
            path_rename: async (oldDirFd, oldPathPtr, oldPathLen, newDirFd, newPathPtr, newPathLen) => unimplemented(),
            path_remove_directory: (dirFd, pathPtr, pathLen) => this._openFiles
                .getPreOpen(dirFd)
                .delete(string.get(this._getBuffer(), pathPtr, pathLen)),
            fd_readdir: async (fd, bufPtr, bufLen, cookie, bufUsedPtr) => {
                const initialBufPtr = bufPtr;
                let openDir = this._openFiles.get(fd).asDir();
                let pos = Number(cookie);
                let entries = openDir.getEntries(pos);
                for await (let handle of entries) {
                    let { name } = handle;
                    let itemSize = dirent_t.size + name.length;
                    if (bufLen < itemSize) {
                        entries.revert(handle);
                        break;
                    }
                    dirent_t.set(this._getBuffer(), bufPtr, {
                        next: ++cookie,
                        ino: 0n,
                        nameLen: name.length,
                        type: handle.isFile ? 4 /* RegularFile */ : 3 /* Directory */
                    });
                    string.set(this._getBuffer(), (bufPtr + dirent_t.size), name);
                    bufPtr = (bufPtr + itemSize);
                    bufLen -= itemSize;
                }
                size_t.set(this._getBuffer(), bufUsedPtr, bufPtr - initialBufPtr);
            },
            path_readlink: (dirFd, pathPtr, pathLen, bufPtr, bufLen, bufUsedPtr) => unimplemented(),
            path_filestat_get: async (dirFd, flags, pathPtr, pathLen, filestatPtr) => {
                let handle = await this._openFiles
                    .getPreOpen(dirFd)
                    .getFileOrDir(string.get(this._getBuffer(), pathPtr, pathLen), 3 /* Any */);
                return this._getFileStat(handle.isFile ? await handle.getFile() : undefined, filestatPtr);
            },
            fd_seek: async (fd, offset, whence, filesizePtr) => {
                let openFile = this._openFiles.get(fd).asFile();
                let base;
                switch (whence) {
                    case 0 /* Current */:
                        base = openFile.position;
                        break;
                    case 1 /* End */:
                        base = (await openFile.getFile()).size;
                        break;
                    case 2 /* Set */:
                        base = 0;
                        break;
                }
                openFile.position = base + Number(offset);
                uint64_t.set(this._getBuffer(), filesizePtr, BigInt(openFile.position));
            },
            fd_tell: (fd, offsetPtr) => {
                uint64_t.set(this._getBuffer(), offsetPtr, BigInt(this._openFiles.get(fd).asFile().position));
            },
            fd_filestat_get: async (fd, filestatPtr) => {
                let openFile = this._openFiles.get(fd);
                this._getFileStat(openFile.isFile ? await openFile.getFile() : undefined, filestatPtr);
            },
            path_unlink_file: (dirFd, pathPtr, pathLen) => this._openFiles
                .getPreOpen(dirFd)
                .delete(string.get(this._getBuffer(), pathPtr, pathLen)),
            poll_oneoff: async (subscriptionPtr, eventsPtr, subscriptionsNum, eventsNumPtr) => {
                if (subscriptionsNum === 0) {
                    throw new RangeError('Polling requires at least one subscription');
                }
                let eventsNum = 0;
                const addEvent = (event) => {
                    Object.assign(event_t.get(this._getBuffer(), eventsPtr), event);
                    eventsNum++;
                    eventsPtr = (eventsPtr + event_t.size);
                };
                let clockEvents = [];
                for (let i = 0; i < subscriptionsNum; i++) {
                    let { userdata, union } = subscription_t.get(this._getBuffer(), subscriptionPtr);
                    subscriptionPtr = (subscriptionPtr + subscription_t.size);
                    switch (union.tag) {
                        case 0 /* Clock */: {
                            let timeout = Number(union.data.timeout) / 1000000;
                            if (union.data.flags === 1 /* Absolute */) {
                                let origin = union.data.id === 0 /* Realtime */ ? Date : performance;
                                timeout -= origin.now();
                            }
                            // This is not completely correct, since setTimeout doesn't give the required precision for monotonic clock.
                            clockEvents.push({
                                timeout,
                                extra: Number(union.data.precision) / 1000000,
                                userdata
                            });
                            break;
                        }
                        default: {
                            addEvent({
                                userdata,
                                error: E.NOSYS,
                                type: union.tag,
                                fd_readwrite: {
                                    nbytes: 0n,
                                    flags: 0 /* None */
                                }
                            });
                            break;
                        }
                    }
                }
                if (!eventsNum) {
                    clockEvents.sort((a, b) => a.timeout - b.timeout);
                    let wait = clockEvents[0].timeout + clockEvents[0].extra;
                    let matchingCount = clockEvents.findIndex(item => item.timeout > wait);
                    matchingCount =
                        matchingCount === -1 ? clockEvents.length : matchingCount;
                    await new Promise(resolve => setTimeout(resolve, clockEvents[matchingCount - 1].timeout));
                    for (let i = 0; i < matchingCount; i++) {
                        addEvent({
                            userdata: clockEvents[i].userdata,
                            error: E.SUCCESS,
                            type: 0 /* Clock */
                        });
                    }
                }
                size_t.set(this._getBuffer(), eventsNumPtr, eventsNum);
            },
            path_link: (oldDirFd, oldFlags, oldPathPtr, oldPathLen, newFd, newPathPtr, newPathLen) => unimplemented(),
            fd_datasync: (fd) => this._openFiles.get(fd).asFile().flush(),
            fd_sync: async (fd) => {
                let openFile = this._openFiles.get(fd);
                if (openFile.isFile) {
                    await openFile.flush();
                }
            },
            fd_filestat_set_size: async (fd, newSize) => this._openFiles.get(fd).asFile().setSize(Number(newSize)),
            fd_renumber: (from, to) => this._openFiles.renumber(from, to),
            path_symlink: (oldPath, fd, newPath) => unimplemented(),
            clock_time_get: (id, precision, resultPtr) => {
                let origin = id === 0 /* Realtime */ ? Date : performance;
                timestamp_t.set(this._getBuffer(), resultPtr, BigInt(Math.round(origin.now() * 1000000)));
            },
            clock_res_get: (id, resultPtr) => {
                timestamp_t.set(this._getBuffer(), resultPtr, /* 1ms */ 1000000n);
            }
        };
        return new Proxy(bindings, {
            get(target, name, receiver) {
                let value = Reflect.get(target, name, receiver);
                if (typeof name !== 'string' || typeof value !== 'function') {
                    return value;
                }
                return async (...args) => {
                    try {
                        await value(...args);
                        return E.SUCCESS;
                    }
                    catch (err) {
                        return translateError(err);
                    }
                };
            }
        });
    }
    async run(module) {
        let { exports: { _start, memory } } = await instantiate(module, {
            wasi_snapshot_preview1: this.getWasiImports()
        });
        this.memory = memory;
        try {
            await _start();
            return 0;
        }
        catch (err) {
            if (err instanceof ExitStatus) {
                return err.statusCode;
            }
            throw err;
        }
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
function translateError(err) {
    if (err instanceof SystemError) {
        console.warn(err);
        return err.code;
    }
    if (err instanceof DOMException) {
        let code;
        switch (err.name) {
            case 'NotFoundError':
                code = E.NOENT;
                break;
            case 'NotAllowedError':
            case 'DataCloneError':
            case 'SecurityError':
                code = E.ACCES;
                break;
            case 'InvalidModificationError':
                code = E.NOTEMPTY;
                break;
            case 'AbortError':
                code = E.CANCELED;
                break;
        }
        if (code) {
            console.warn(err);
            return code;
        }
    }
    else if (err instanceof TypeError || err instanceof RangeError) {
        console.warn(err);
        return E.INVAL;
    }
    throw err;
}
//# sourceMappingURL=bindings.js.map