import { fd_t, OpenFlags } from './bindings';

export const PREOPEN = '/';
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
    return this._writer || (this._writer = await this._handle.createWriter());
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
    this._add(PREOPEN, _rootHandle);
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
    if (!path.startsWith('/')) {
      throw new Error('Non-absolute path.');
    }
    path = path.slice(1);
    if (!path) {
      if (mode & FileOrDir.Dir) {
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
    async function openWithCreate(create: boolean) {
      if (mode & FileOrDir.File) {
        try {
          return await curDir.getFile(lastItem, { create });
        } catch (e) {
          if (!(mode & FileOrDir.Dir)) {
            throw e;
          }
        }
      }
      return curDir.getDirectory(lastItem, { create });
    }
    if (openFlags & OpenFlags.Directory) {
      if (mode & FileOrDir.Dir) {
        mode = FileOrDir.Dir;
      } else {
        throw new Error('Asked for a file but opening as a directory.');
      }
    }
    let handle: Handle;
    if (openFlags & OpenFlags.Create) {
      if (openFlags & OpenFlags.Exclusive) {
        let exists = false;
        try {
          await openWithCreate(false);
          exists = true;
        } catch {}
        if (exists) {
          throw new Error('Already exists.');
        }
      }
      handle = await openWithCreate(true);
    } else {
      handle = await openWithCreate(false);
    }
    if (openFlags & OpenFlags.Truncate) {
      if (handle.isDirectory) {
        throw new Error('Tried to truncate a directory.');
      }
      await (await handle.createWriter({ keepExistingData: false })).close();
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
    return this._files.get(fd);
  }

  close(fd: fd_t) {
    if (!this._files.delete(fd)) {
      throw new Error('Tried to close a non-existing file.');
    }
  }
}
