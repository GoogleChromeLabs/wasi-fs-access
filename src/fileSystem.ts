import { fd_t, OpenFlags, SystemError, E } from './bindings.js';

export type Handle = FileSystemFileHandle | FileSystemDirectoryHandle;

class OpenDirectory {
  constructor(
    public readonly path: string,
    private readonly _handle: FileSystemDirectoryHandle
  ) {}

  isFile!: false;

  asFile(): never {
    throw new SystemError(E.ISDIR, this.path);
  }

  asDir() {
    return this;
  }

  getEntries() {
    return this._handle.getEntries();
  }

  private async _resolve(path: string) {
    let parts = path ? path.split('/') : [];
    let resolvedParts = [];
    for (let item of parts) {
      if (item === '..') {
        if (resolvedParts.pop() === undefined) {
          throw new SystemError(E.ACCES, this.path + '/..');
        }
      } else if (item !== '.') {
        resolvedParts.push(item);
      }
    }
    let name = resolvedParts.pop();
    let parent = this._handle;
    for (let item of resolvedParts) {
      parent = await parent.getDirectory(item);
    }
    return {
      parent,
      name
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
    let { parent, name: maybeName } = await this._resolve(path);
    // Handle case when we couldn't get a parent, only direct handle
    // (this means it's a preopened directory).
    if (maybeName === undefined) {
      if (mode & FileOrDir.Dir) {
        if (openFlags & (OpenFlags.Create | OpenFlags.Exclusive)) {
          throw new SystemError(E.EXIST, path);
        }
        if (openFlags & OpenFlags.Truncate) {
          throw new SystemError(E.ISDIR, path);
        }
        return parent;
      } else {
        throw new SystemError(E.ISDIR, path);
      }
    }
    let name = maybeName;
    async function openWithCreate(create: boolean) {
      if (mode & FileOrDir.File) {
        try {
          return await parent.getFile(name, { create });
        } catch (e) {
          if (e.name === 'TypeMismatchError') {
            if (!(mode & FileOrDir.Dir)) {
              console.warn(e);
              throw new SystemError(E.ISDIR, path);
            }
          } else {
            throw e;
          }
        }
      }
      try {
        return await parent.getDirectory(name, { create });
      } catch (e) {
        if (e.name === 'TypeMismatchError') {
          console.warn(e);
          throw new SystemError(E.NOTDIR, path);
        } else {
          throw e;
        }
      }
    }
    if (openFlags & OpenFlags.Directory) {
      if (mode & FileOrDir.Dir) {
        mode = FileOrDir.Dir;
      } else {
        throw new TypeError(`Open flags ${openFlags} require a directory but mode ${mode} doesn't allow it.`);
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
        await handle.createWritable({ keepExistingData: false });
      } catch {
        throw new SystemError(E.ACCES, path);
      }
    }
    return handle;
  }

  async delete(path: string) {
    let { parent, name } = await this._resolve(path);
    if (!name) {
      throw new SystemError(E.ACCES, path);
    }
    await parent.removeEntry(name);
  }

  close() {}
}

OpenDirectory.prototype.isFile = false;

// Note: currently this class might return inconsistent results if file
// is both being written to (without flush) and read from.
//
// In principle, this matches behaviour of many other platforms, but
// would be good to understand what are the expectations of WASI here.
class OpenFile {
  constructor(
    public readonly path: string,
    private readonly _handle: FileSystemFileHandle
  ) {}

  isFile!: true;

  public position = 0;
  private _file: File | undefined;
  private _writer: FileSystemWriter | undefined;

  async getFile() {
    return this._file || (this._file = await this._handle.getFile());
  }

  private async _getWriter() {
    return (
      this._writer ||
      (this._writer = await this._handle.createWritable({
        keepExistingData: true
      }))
    );
  }

  async setSize(size: number) {
    let writer = await this._getWriter();
    await writer.truncate(size);
  }

  async read(len: number) {
    let file = await this.getFile();
    let slice = file.slice(this.position, this.position + len);
    let arrayBuffer = await slice.arrayBuffer();
    this.position += arrayBuffer.byteLength;
    return new Uint8Array(arrayBuffer);
  }

  async write(data: Uint8Array) {
    let writer = await this._getWriter();
    await writer.write(this.position, data);
    this.position += data.length;
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

  close() {
    return this.flush();
  }
}

OpenFile.prototype.isFile = true;

export const enum FileOrDir {
  File = 1 << 0,
  Dir = 1 << 1,
  Any = File | Dir
}

export const FIRST_PREOPEN_FD = 3 as fd_t;

export class OpenFiles {
  private _files = new Map<fd_t, OpenFile | OpenDirectory>();
  private _nextFd = FIRST_PREOPEN_FD;
  private readonly _firstNonPreopenFd: fd_t;

  constructor(preOpen: Record<string, FileSystemDirectoryHandle>) {
    for (let path in preOpen) {
      this._add(path, preOpen[path]);
    }
    this._firstNonPreopenFd = this._nextFd;
  }

  getPreOpen(fd: fd_t): OpenDirectory {
    if (fd >= FIRST_PREOPEN_FD && fd < this._firstNonPreopenFd) {
      return this.get(fd) as OpenDirectory;
    } else {
      throw new SystemError(E.BADF, fd);
    }
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

  async open(preOpen: OpenDirectory, path: string, openFlags?: OpenFlags) {
    return this._add(
      `${preOpen.path}/${path}`,
      await preOpen.getFileOrDir(path, FileOrDir.Any, openFlags)
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
    await this.get(fd).close();
    this._files.delete(fd);
  }
}
