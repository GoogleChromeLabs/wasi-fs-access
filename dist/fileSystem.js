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
import { SystemError, E } from './bindings.js';
class OpenDirectory {
    constructor(path, _handle) {
        this.path = path;
        this._handle = _handle;
        this._currentIter = undefined;
    }
    asFile() {
        throw new SystemError(E.ISDIR);
    }
    asDir() {
        return this;
    }
    getEntries(start = 0) {
        if (this._currentIter?.pos !== start) {
            // We're at incorrect position and will have to skip [start] items.
            this._currentIter = {
                pos: 0,
                reverted: undefined,
                iter: this._handle.values()
            };
        }
        else {
            // We are already at correct position, so zero this out.
            start = 0;
        }
        let currentIter = this._currentIter;
        return {
            next: async () => {
                // This is a rare case when the caller tries to start reading directory
                // from a different position than our iterator is on.
                //
                // This can happen e.g. with multiple iterators, or if previous iteration
                // has been cancelled.
                //
                // In those cases, we need to first manually skip [start] items from the
                // iterator, and on the next calls we'll be able to continue normally.
                for (; start; start--) {
                    await currentIter.iter.next();
                }
                // If there is a handle saved by a `revert(...)` call, take and return it.
                let { reverted } = currentIter;
                if (reverted) {
                    currentIter.reverted = undefined;
                    currentIter.pos++;
                    return {
                        value: reverted,
                        done: false
                    };
                }
                // Otherwise use the underlying iterator.
                let res = await currentIter.iter.next();
                if (!res.done) {
                    currentIter.pos++;
                }
                return res;
            },
            // This function allows to go one step back in the iterator
            // by saving an item in an internal buffer.
            // That item will be given back on the next iteration attempt.
            //
            // This allows to avoid having to restart the underlying
            // forward iterator over and over again just to find the required
            // position.
            revert: (handle) => {
                if (currentIter.reverted || currentIter.pos === 0) {
                    throw new Error('Cannot revert a handle in the current state.');
                }
                currentIter.pos--;
                currentIter.reverted = handle;
            },
            [Symbol.asyncIterator]() {
                return this;
            }
        };
    }
    async _resolve(path) {
        let parts = path ? path.split('/') : [];
        let resolvedParts = [];
        for (let item of parts) {
            if (item === '..') {
                if (resolvedParts.pop() === undefined) {
                    throw new SystemError(E.NOTCAPABLE);
                }
            }
            else if (item !== '.') {
                resolvedParts.push(item);
            }
        }
        let name = resolvedParts.pop();
        let parent = this._handle;
        for (let item of resolvedParts) {
            parent = await parent.getDirectoryHandle(item);
        }
        return {
            parent,
            name
        };
    }
    async getFileOrDir(path, mode, openFlags = 0) {
        let { parent, name: maybeName } = await this._resolve(path);
        // Handle case when we couldn't get a parent, only direct handle
        // (this means it's a preopened directory).
        if (maybeName === undefined) {
            if (mode & 2 /* Dir */) {
                if (openFlags & (1 /* Create */ | 4 /* Exclusive */)) {
                    throw new SystemError(E.EXIST);
                }
                if (openFlags & 8 /* Truncate */) {
                    throw new SystemError(E.ISDIR);
                }
                return parent;
            }
            else {
                throw new SystemError(E.ISDIR);
            }
        }
        let name = maybeName;
        async function openWithCreate(create) {
            if (mode & 1 /* File */) {
                try {
                    return await parent.getFileHandle(name, { create });
                }
                catch (err) {
                    if (err.name === 'TypeMismatchError') {
                        if (!(mode & 2 /* Dir */)) {
                            console.warn(err);
                            throw new SystemError(E.ISDIR);
                        }
                    }
                    else {
                        throw err;
                    }
                }
            }
            try {
                return await parent.getDirectoryHandle(name, { create });
            }
            catch (err) {
                if (err.name === 'TypeMismatchError') {
                    console.warn(err);
                    throw new SystemError(E.NOTDIR);
                }
                else {
                    throw err;
                }
            }
        }
        if (openFlags & 2 /* Directory */) {
            if (mode & 2 /* Dir */) {
                mode = 2 /* Dir */;
            }
            else {
                throw new TypeError(`Open flags ${openFlags} require a directory but mode ${mode} doesn't allow it.`);
            }
        }
        let handle;
        if (openFlags & 1 /* Create */) {
            if (openFlags & 4 /* Exclusive */) {
                let exists = true;
                try {
                    await openWithCreate(false);
                }
                catch {
                    exists = false;
                }
                if (exists) {
                    throw new SystemError(E.EXIST);
                }
            }
            handle = await openWithCreate(true);
        }
        else {
            handle = await openWithCreate(false);
        }
        if (openFlags & 8 /* Truncate */) {
            if (handle.isDirectory) {
                throw new SystemError(E.ISDIR);
            }
            let writable = await handle.createWritable({ keepExistingData: false });
            await writable.close();
        }
        return handle;
    }
    async delete(path) {
        let { parent, name } = await this._resolve(path);
        if (!name) {
            throw new SystemError(E.ACCES);
        }
        await parent.removeEntry(name);
    }
    close() { }
}
OpenDirectory.prototype.isFile = false;
class OpenFile {
    constructor(path, _handle) {
        this.path = path;
        this._handle = _handle;
        this.position = 0;
        this._writer = undefined;
    }
    async getFile() {
        // TODO: do we really have to?
        await this.flush();
        return this._handle.getFile();
    }
    async _getWriter() {
        return (this._writer ||
            (this._writer = await this._handle.createWritable({
                keepExistingData: true
            })));
    }
    async setSize(size) {
        let writer = await this._getWriter();
        await writer.truncate(size);
    }
    async read(len) {
        let file = await this.getFile();
        let slice = file.slice(this.position, this.position + len);
        let arrayBuffer = await slice.arrayBuffer();
        this.position += arrayBuffer.byteLength;
        return new Uint8Array(arrayBuffer);
    }
    async write(data) {
        let writer = await this._getWriter();
        await writer.write({ type: 'write', position: this.position, data });
        this.position += data.length;
    }
    async flush() {
        if (!this._writer)
            return;
        await this._writer.close();
        this._writer = undefined;
    }
    asFile() {
        return this;
    }
    asDir() {
        throw new SystemError(E.NOTDIR);
    }
    close() {
        return this.flush();
    }
}
OpenFile.prototype.isFile = true;
export const FIRST_PREOPEN_FD = 3;
export class OpenFiles {
    constructor(preOpen) {
        this._files = new Map();
        this._nextFd = FIRST_PREOPEN_FD;
        for (let path in preOpen) {
            this._add(path, preOpen[path]);
        }
        this._firstNonPreopenFd = this._nextFd;
    }
    getPreOpen(fd) {
        if (fd >= FIRST_PREOPEN_FD && fd < this._firstNonPreopenFd) {
            return this.get(fd);
        }
        else {
            throw new SystemError(E.BADF, true);
        }
    }
    _add(path, handle) {
        this._files.set(this._nextFd, handle.kind === 'file'
            ? new OpenFile(path, handle)
            : new OpenDirectory(path, handle));
        return this._nextFd++;
    }
    async open(preOpen, path, openFlags) {
        return this._add(`${preOpen.path}/${path}`, await preOpen.getFileOrDir(path, 3 /* Any */, openFlags));
    }
    get(fd) {
        let openFile = this._files.get(fd);
        if (!openFile) {
            throw new SystemError(E.BADF);
        }
        return openFile;
    }
    _take(fd) {
        let handle = this.get(fd);
        this._files.delete(fd);
        return handle;
    }
    async renumber(from, to) {
        await this.close(to);
        this._files.set(to, this._take(from));
    }
    async close(fd) {
        await this._take(fd).close();
    }
    // Translation of the algorithm from __wasilibc_find_relpath.
    findRelPath(path) {
        /// Are the `prefix_len` bytes pointed to by `prefix` a prefix of `path`?
        function prefixMatches(prefix, path) {
            // Allow an empty string as a prefix of any relative path.
            if (path[0] != '/' && !prefix) {
                return true;
            }
            // Check whether any bytes of the prefix differ.
            if (!path.startsWith(prefix)) {
                return false;
            }
            // Ignore trailing slashes in directory names.
            let i = prefix.length;
            while (i > 0 && prefix[i - 1] == '/') {
                --i;
            }
            // Match only complete path components.
            let last = path[i];
            return last === '/' || !last;
        }
        // Search through the preopens table. Iterate in reverse so that more
        // recently added preopens take precedence over less recently addded ones.
        let matchLen = 0;
        let foundPre;
        for (let i = this._firstNonPreopenFd - 1; i >= FIRST_PREOPEN_FD; --i) {
            let pre = this.get(i);
            let prefix = pre.path;
            if (path !== '.' && !path.startsWith('./')) {
                // We're matching a relative path that doesn't start with "./" and
                // isn't ".".
                if (prefix.startsWith('./')) {
                    prefix = prefix.slice(2);
                }
                else if (prefix === '.') {
                    prefix = prefix.slice(1);
                }
            }
            // If we haven't had a match yet, or the candidate path is longer than
            // our current best match's path, and the candidate path is a prefix of
            // the requested path, take that as the new best path.
            if ((!foundPre || prefix.length > matchLen) &&
                prefixMatches(prefix, path)) {
                foundPre = pre;
                matchLen = prefix.length;
            }
        }
        if (!foundPre) {
            throw new Error(`Couldn't resolve the given path via preopened directories.`);
        }
        // The relative path is the substring after the portion that was matched.
        let computed = path.slice(matchLen);
        // Omit leading slashes in the relative path.
        computed = computed.replace(/^\/+/, '');
        // *at syscalls don't accept empty relative paths, so use "." instead.
        computed = computed || '.';
        return {
            preOpen: foundPre,
            relativePath: computed
        };
    }
}
//# sourceMappingURL=fileSystem.js.map