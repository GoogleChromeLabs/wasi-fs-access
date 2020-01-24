import { fd_t } from './bindings';

export const PREOPEN = '/';
export const PREOPEN_FD = 3 as fd_t;

type Handle = FileSystemFileHandle | FileSystemDirectoryHandle;

type OpenFile = {
  handle: Handle;
  path: string;
  position: number;
};

export class OpenFiles {
  private _files = new Map<fd_t, OpenFile>();
  private _nextFd = PREOPEN_FD;

  constructor(private _rootHandle: FileSystemDirectoryHandle) {
    this._add(PREOPEN, _rootHandle);
  }

  getFileOrDir(
    path: string,
    mode: 'file',
    create: boolean
  ): Promise<FileSystemFileHandle>;
  getFileOrDir(
    path: string,
    mode: 'dir',
    create: boolean
  ): Promise<FileSystemDirectoryHandle>;
  getFileOrDir(
    path: string,
    mode: 'fileOrDir',
    create: boolean
  ): Promise<Handle>;
  async getFileOrDir(
    path: string,
    mode: 'file' | 'dir' | 'fileOrDir',
    create: boolean
  ) {
    if (!path.startsWith('/')) {
      throw new Error('Non-absolute path.');
    }
    path = path.slice(1);
    if (!path) {
      if (mode !== 'file') {
        return this._rootHandle;
      } else {
        throw new Error('Requested a file, but got root directory.');
      }
    }
    let items = path.split('/');
    let lastItem = items.pop()!;
    let curDir = this._rootHandle;
    for (let chunk of items) {
      curDir = await curDir.getDirectory(chunk);
    }
    if (mode === 'file') {
      return curDir.getFile(lastItem, { create });
    } else if (mode === 'dir') {
      return curDir.getDirectory(lastItem, { create });
    } else {
      try {
        return await curDir.getFile(lastItem, { create });
      } catch {
        return curDir.getDirectory(lastItem, { create });
      }
    }
  }

  private _add(path: string, handle: Handle) {
    this._files.set(this._nextFd, {
      path,
      handle,
      position: 0
    });
    return this._nextFd++ as fd_t;
  }

  async open(path: string) {
    return this._add(path, await this.getFileOrDir(path, 'fileOrDir', false));
  }

  get(fd: fd_t) {
    let file = this._files.get(fd);
    if (!file) {
      throw new Error('Tried to retrieve a non-existing file.');
    }
    return file;
  }

  close(fd: fd_t) {
    if (!this._files.delete(fd)) {
      throw new Error('Tried to close a non-existing file.');
    }
  }
}
