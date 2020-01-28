import { fd_t, OpenFlags, SystemError, E } from './bindings.js';

export const PREOPEN_FD = 3 as fd_t;

export type Handle = FileSystemFileHandle | FileSystemDirectoryHandle;

class OpenDirectory {
  constructor(
    public readonly path: string,
    private readonly _handle: FileSystemDirectoryHandle
  ) {}

  isFile!: false;

  getEntries() {
    return this._handle.getEntries();
  }

  asFile(): never {
    throw new SystemError(E.ISDIR, this.path);
  }

  asDir() {
    return this;
  }
}

OpenDirectory.prototype.isFile = false;

class OpenFile {
  constructor(
    public readonly path: string,
    private readonly _handle: FileSystemFileHandle
  ) {}

  isFile!: true;

  private _position = 0;
  private _file: File | undefined;
  private _writer: FileSystemWriter | undefined;

  async getFile() {
    return this._file || (this._file = await this._handle.getFile());
  }

  private async _getWriter() {
    try {
      return this._writer || (this._writer = await this._handle.createWriter());
    } catch {
      throw new SystemError(E.ACCES, this.path);
    }
  }

  getPosition() {
    return this._position;
  }

  setPosition(position: number) {
    this._position = position;
  }

  async setSize(size: number) {
    let writer = await this._getWriter();
    await writer.truncate(size);
  }

  async read(len: number) {
    let file = await this.getFile();
    let slice = file.slice(this._position, this._position + len);
    let arrayBuffer: ArrayBuffer = await (slice as any).arrayBuffer();
    this._position += arrayBuffer.byteLength;
    return new Uint8Array(arrayBuffer);
  }

  async write(data: Uint8Array) {
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

  asDir(): never {
    throw new SystemError(E.NOTDIR, this.path);
  }
}

OpenFile.prototype.isFile = true;

export const enum FileOrDir {
  File = 1 << 0,
  Dir = 1 << 1
}

export class OpenFiles {
  private _files = new Map<fd_t, OpenFile | OpenDirectory>();
  private _nextFd = PREOPEN_FD;

  constructor(private _rootHandle: FileSystemDirectoryHandle) {
    this._add('/', _rootHandle);
  }

  private async _getParent(path: string) {
    if (!path.startsWith('/')) {
      throw new SystemError(E.INVAL, path);
    }
    path = path.slice(1);
    let items = path.split('/');
    let lastItem = items.pop()!;
    let curDir = this._rootHandle;
    for (let [i, chunk] of items.entries()) {
      try {
        curDir = await curDir.getDirectory(chunk);
      } catch {
        throw new SystemError(E.NOENT, '/' + items.slice(0, i).join('/'));
      }
    }
    return {
      parent: curDir,
      name: lastItem
    };
  }

  getFileOrDir(
    path: string,
    mode: FileOrDir,
    openFlags?: OpenFlags
  ): Promise<FileSystemFileHandle>;
  getFileOrDir(
    path: string,
    mode: FileOrDir,
    openFlags?: OpenFlags
  ): Promise<FileSystemDirectoryHandle>;
  getFileOrDir(
    path: string,
    mode: FileOrDir,
    openFlags?: OpenFlags
  ): Promise<Handle>;
  async getFileOrDir(path: string, mode: FileOrDir, openFlags: OpenFlags = 0) {
    if (path === '/') {
      if (
        mode & FileOrDir.Dir &&
        !(openFlags & (OpenFlags.Create | OpenFlags.Truncate))
      ) {
        return this._rootHandle;
      } else {
        throw new SystemError(E.ACCES, path);
      }
    }
    let { parent, name } = await this._getParent(path);
    async function openWithCreate(create: boolean) {
      if (mode & FileOrDir.File) {
        try {
          return await parent.getFile(name, { create });
        } catch (e) {
          if (!(mode & FileOrDir.Dir)) {
            throw e;
          }
        }
      }
      return parent.getDirectory(name, { create });
    }
    if (openFlags & OpenFlags.Directory) {
      if (mode & FileOrDir.Dir) {
        mode = FileOrDir.Dir;
      } else {
        throw new SystemError(E.INVAL, openFlags);
      }
    }
    let handle: Handle;
    if (openFlags & OpenFlags.Create) {
      if (openFlags & OpenFlags.Exclusive) {
        let exists = true;
        try {
          await openWithCreate(false);
        } catch {
          exists = false;
        }
        if (exists) {
          throw new SystemError(E.EXIST, path);
        }
      }
      try {
        handle = await openWithCreate(true);
      } catch {
        throw new SystemError(E.ACCES, path);
      }
    } else {
      try {
        handle = await openWithCreate(false);
      } catch {
        throw new SystemError(E.NOENT, path);
      }
    }
    if (openFlags & OpenFlags.Truncate) {
      if (handle.isDirectory) {
        throw new SystemError(E.ISDIR, path);
      }
      try {
        await (await handle.createWriter({ keepExistingData: false })).close();
      } catch {
        throw new SystemError(E.ACCES, path);
      }
    }
    return handle;
  }

  private _add(path: string, handle: Handle) {
    this._files.set(
      this._nextFd,
      handle.isFile
        ? new OpenFile(path, handle)
        : new OpenDirectory(path, handle)
    );
    return this._nextFd++ as fd_t;
  }

  async open(path: string, openFlags?: OpenFlags) {
    return this._add(
      path,
      await this.getFileOrDir(path, FileOrDir.File | FileOrDir.Dir, openFlags)
    );
  }

  get(fd: fd_t) {
    let openFile = this._files.get(fd);
    if (!openFile) {
      throw new SystemError(E.BADF, fd);
    }
    return openFile;
  }

  async close(fd: fd_t) {
    let file = this.get(fd);
    if (file.isFile) {
      await file.flush();
    }
  }

  async delete(path: string) {
    let { parent, name } = await this._getParent(path);
    await parent.removeEntry(name);
  }
}
