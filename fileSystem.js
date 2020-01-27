export const PREOPEN = '/';
export const PREOPEN_FD = 3;
class OpenDirectory {
    constructor(path, _handle) {
        this.path = path;
        this._handle = _handle;
    }
    getEntries() {
        return this._handle.getEntries();
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
        return this._writer || (this._writer = await this._handle.createWriter());
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
}
OpenFile.prototype.isFile = true;
export class OpenFiles {
    constructor(_rootHandle) {
        this._rootHandle = _rootHandle;
        this._files = new Map();
        this._nextFd = PREOPEN_FD;
        this._add(PREOPEN, _rootHandle);
    }
    async getFileOrDir(path, mode, create) {
        if (!path.startsWith('/')) {
            throw new Error('Non-absolute path.');
        }
        path = path.slice(1);
        if (!path) {
            if (mode !== 'file') {
                return this._rootHandle;
            }
            else {
                throw new Error('Requested a file, but got root directory.');
            }
        }
        let items = path.split('/');
        let lastItem = items.pop();
        let curDir = this._rootHandle;
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
    _add(path, handle) {
        this._files.set(this._nextFd, handle.isFile
            ? new OpenFile(path, handle)
            : new OpenDirectory(path, handle));
        return this._nextFd++;
    }
    async open(path, create = false) {
        return this._add(path, await this.getFileOrDir(path, 'fileOrDir', create));
    }
    get(fd) {
        return this._files.get(fd);
    }
    close(fd) {
        if (!this._files.delete(fd)) {
            throw new Error('Tried to close a non-existing file.');
        }
    }
}
