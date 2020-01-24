export const PREOPEN = '/';
export const PREOPEN_FD = 3;
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
        this._files.set(this._nextFd, {
            path,
            handle,
            position: 0
        });
        return this._nextFd++;
    }
    async open(path) {
        return this._add(path, await this.getFileOrDir(path, 'fileOrDir', false));
    }
    get(fd) {
        let file = this._files.get(fd);
        if (!file) {
            throw new Error('Tried to retrieve a non-existing file.');
        }
        return file;
    }
    close(fd) {
        if (!this._files.delete(fd)) {
            throw new Error('Tried to close a non-existing file.');
        }
    }
}
