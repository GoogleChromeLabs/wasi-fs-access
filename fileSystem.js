import { SystemError, E } from './bindings.js';
export const PREOPEN_FD = 3;
class OpenDirectory {
    constructor(path, _handle) {
        this.path = path;
        this._handle = _handle;
    }
    getEntries() {
        return this._handle.getEntries();
    }
    asFile() {
        throw new SystemError(E.ISDIR, this.path);
    }
    asDir() {
        return this;
    }
}
OpenDirectory.prototype.isFile = false;
class OpenFile {
    constructor(path, _handle) {
        this.path = path;
        this._handle = _handle;
        this._position = 0;
    }
    async getFile() {
        return this._file || (this._file = await this._handle.getFile());
    }
    async _getWriter() {
        try {
            return this._writer || (this._writer = await this._handle.createWriter());
        }
        catch {
            throw new SystemError(E.ACCES, this.path);
        }
    }
    getPosition() {
        return this._position;
    }
    setPosition(position) {
        this._position = position;
    }
    async setSize(size) {
        let writer = await this._getWriter();
        await writer.truncate(size);
    }
    async read(len) {
        let file = await this.getFile();
        let slice = file.slice(this._position, this._position + len);
        let arrayBuffer = await slice.arrayBuffer();
        this._position += arrayBuffer.byteLength;
        return new Uint8Array(arrayBuffer);
    }
    async write(data) {
        let writer = await this._getWriter();
        await writer.write(this._position, data);
        this._position += data.length;
    }
    async flush() {
        await this._writer?.close();
        this._writer = undefined;
        this._file = undefined;
    }
    asFile() {
        return this;
    }
    asDir() {
        throw new SystemError(E.NOTDIR, this.path);
    }
}
OpenFile.prototype.isFile = true;
export class OpenFiles {
    constructor(_rootHandle) {
        this._rootHandle = _rootHandle;
        this._files = new Map();
        this._nextFd = PREOPEN_FD;
        this._add('/', _rootHandle);
    }
    async _getParent(path) {
        if (!path.startsWith('/')) {
            throw new SystemError(E.INVAL, path);
        }
        path = path.slice(1);
        let items = path.split('/');
        let lastItem = items.pop();
        let curDir = this._rootHandle;
        for (let [i, chunk] of items.entries()) {
            try {
                curDir = await curDir.getDirectory(chunk);
            }
            catch {
                throw new SystemError(E.NOENT, '/' + items.slice(0, i).join('/'));
            }
        }
        return {
            parent: curDir,
            name: lastItem
        };
    }
    async getFileOrDir(path, mode, openFlags = 0) {
        if (path === '/') {
            if (mode & 2 /* Dir */ &&
                !(openFlags & (1 /* Create */ | 8 /* Truncate */))) {
                return this._rootHandle;
            }
            else {
                throw new SystemError(E.ACCES, path);
            }
        }
        let { parent, name } = await this._getParent(path);
        async function openWithCreate(create) {
            if (mode & 1 /* File */) {
                try {
                    return await parent.getFile(name, { create });
                }
                catch (e) {
                    if (!(mode & 2 /* Dir */)) {
                        throw e;
                    }
                }
            }
            return parent.getDirectory(name, { create });
        }
        if (openFlags & 2 /* Directory */) {
            if (mode & 2 /* Dir */) {
                mode = 2 /* Dir */;
            }
            else {
                throw new SystemError(E.INVAL, openFlags);
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
                    throw new SystemError(E.EXIST, path);
                }
            }
            try {
                handle = await openWithCreate(true);
            }
            catch {
                throw new SystemError(E.ACCES, path);
            }
        }
        else {
            try {
                handle = await openWithCreate(false);
            }
            catch {
                throw new SystemError(E.NOENT, path);
            }
        }
        if (openFlags & 8 /* Truncate */) {
            if (handle.isDirectory) {
                throw new SystemError(E.ISDIR, path);
            }
            try {
                await (await handle.createWriter({ keepExistingData: false })).close();
            }
            catch {
                throw new SystemError(E.ACCES, path);
            }
        }
        return handle;
    }
    _add(path, handle) {
        this._files.set(this._nextFd, handle.isFile
            ? new OpenFile(path, handle)
            : new OpenDirectory(path, handle));
        return this._nextFd++;
    }
    async open(path, openFlags) {
        return this._add(path, await this.getFileOrDir(path, 1 /* File */ | 2 /* Dir */, openFlags));
    }
    get(fd) {
        let openFile = this._files.get(fd);
        if (!openFile) {
            throw new SystemError(E.BADF, fd);
        }
        return openFile;
    }
    async close(fd) {
        let file = this.get(fd);
        if (file.isFile) {
            await file.flush();
        }
    }
    async delete(path) {
        let { parent, name } = await this._getParent(path);
        await parent.removeEntry(name);
    }
}
