import {
  OpenFiles,
  PREOPEN_FD,
  PREOPEN,
  Handle,
  FileOrDir
} from './fileSystem.js';

type ptr<T> = number & { _pointerTarget: T };

export const EXIT = Symbol();

interface TypeInfo {
  size: number;
  align: number;
}

interface ReadableType<T> extends TypeInfo {
  get(buf: ArrayBuffer, ptr: ptr<T>): T;
}

interface WritableType<T> extends ReadableType<T> {
  set(buf: ArrayBuffer, ptr: ptr<T>, value: T): void;
}

type TargetType<I> = I extends ReadableType<infer T> ? T : never;

const getDataView = (() => {
  const cache = new WeakMap<ArrayBuffer, DataView>();

  return (buf: ArrayBuffer) => {
    let dataView = cache.get(buf);
    if (!dataView) {
      dataView = new DataView(buf);
      cache.set(buf, dataView);
    }
    return dataView;
  };
})();

function std<T = number>(name: string, size: number): WritableType<T> {
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
    get(buf: ArrayBuffer, ptr: ptr<string>, len: number) {
      return textDecoder.decode(new Uint8Array(buf, ptr, len));
    },
    set(
      buf: ArrayBuffer,
      ptr: ptr<string>,
      value: string,
      len: number = value.length
    ) {
      let { read } = textEncoder.encodeInto(
        value,
        new Uint8Array(buf, ptr, len)
      );
      if (read! < value.length) {
        throw new Error(`Insufficient space.`);
      }
    }
  };
})();

function alignTo(ptr: number, align: number): number {
  let mismatch = ptr % align;
  if (mismatch) {
    ptr += align - mismatch;
  }
  return ptr;
}

function struct<T extends Record<string, WritableType<any>>>(
  desc: T
): ReadableType<
  { [K in keyof T]: T[K] extends WritableType<infer F> ? F : never }
> {
  class Ctor {
    constructor(protected _buf: ArrayBuffer, protected _ptr: number) {}
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
      get(this: Ctor) {
        return type.get(this._buf, (this._ptr + fieldOffset) as ptr<any>);
      },
      set(this: Ctor, value) {
        type.set(this._buf, (this._ptr + fieldOffset) as ptr<any>, value);
      }
    });
    offset += type.size;
  }
  offset = alignTo(offset, structAlign);
  return {
    size: offset,
    align: structAlign,
    get(buf, ptr) {
      return new Ctor(buf, ptr) as any;
    }
  };
}

function enumer<E extends number>(base: WritableType<number>): WritableType<E> {
  return {
    size: base.size,
    align: base.align,
    get(buf, ptr) {
      return base.get(buf, ptr) as E;
    },
    set(buf, ptr, value) {
      base.set(buf, ptr, value);
    }
  };
}

const int8_t = std('Int8', 1);
const uint8_t = std('Uint8', 1);
const int16_t = std('Int16', 2);
const uint16_t = std('Uint16', 2);
const int32_t = std('Int32', 4);
const uint32_t = std('Uint32', 4);
const int64_t = std<bigint>('bigint64', 8);
const uint64_t = std<bigint>('BigUint64', 8);

const size_t = uint32_t;

const enum PreOpenType {
  Dir
}
const preopentype_t = enumer<PreOpenType>(int8_t);

const prestat_t = struct({
  type: preopentype_t,
  nameLen: size_t
});
type prestat_t = TargetType<typeof prestat_t>;

export type fd_t = number & { _name: 'fd' };
export const fd_t = uint32_t as WritableType<fd_t>;

const iovec_t = struct({
  bufPtr: uint32_t,
  bufLen: size_t
});
type iovec_t = TargetType<typeof iovec_t>;

const enum FileType {
  Unknown,
  BlockDevice,
  CharacterDevice,
  Directory,
  RegularFile,
  SocketDatagram,
  SocketStream,
  SymbolicLink
}
const filetype_t = enumer<FileType>(uint8_t);

const fdflags_t = enumer<FdFlags>(uint16_t);

const rights_t = uint64_t;

const fdstat_t = struct({
  filetype: filetype_t,
  flags: fdflags_t,
  rightsBase: rights_t,
  rightsInheriting: rights_t
});
type fdstat_t = TargetType<typeof fdstat_t>;

const dircookie_t = uint64_t;

const inode_t = uint64_t;

const dirent_t = struct({
  next: dircookie_t,
  ino: inode_t,
  nameLen: uint32_t,
  type: filetype_t
});
type dirent_t = TargetType<typeof dirent_t>;

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
type filestat_t = TargetType<typeof filestat_t>;

const enum E {
  BADF = 8,
  INVAL = 28,
  ISDIR = 31,
  NOENT = 44,
  NOSYS = 52,
  NOTDIR = 54
}

const enum Whence {
  Current,
  End,
  Set
}

export const enum OpenFlags {
  Create = 1 << 0,
  Directory = 1 << 1,
  Exclusive = 1 << 2,
  Truncate = 1 << 3
}

export const enum FdFlags {
  Append = 1 << 0,
  DSync = 1 << 1,
  NonBlock = 1 << 2,
  RSync = 1 << 3,
  Sync = 1 << 4
}

interface Out {
  write(data: Uint8Array): void | Promise<void>;
}

class StdOut {
  private _buffer = '';
  private _decoder = new TextDecoder();

  constructor(public writeLn: (line: string) => void) {}

  write(data: Uint8Array) {
    let lines = (
      this._buffer + this._decoder.decode(data, { stream: true })
    ).split('\n');
    this._buffer = lines.pop()!;
    for (let line of lines) {
      this.writeLn(line);
    }
  }
}

function unimplemented() {
  console.trace('Invoked unimplemented function.');
  return E.NOSYS;
}

export default class Bindings {
  private _openFiles: OpenFiles;

  private _argOffsets: Uint32Array;
  private _argBuf: string;

  private _envOffsets: Uint32Array;
  private _envBuf: string;

  private _stdOut: Out;
  private _stdErr: Out;

  constructor({
    rootHandle,
    stdout = new StdOut(console.log),
    stderr = new StdOut(console.error),
    args = [],
    env = {}
  }: {
    rootHandle: FileSystemDirectoryHandle;
    stdout?: Out;
    stderr?: Out;
    args?: string[];
    env?: Record<string, string>;
  }) {
    this._openFiles = new OpenFiles(rootHandle);

    // Set args.
    {
      this._argOffsets = new Uint32Array(args.length);
      this._argBuf = '';
      for (let [i, arg] of args.entries()) {
        this._argOffsets[i] = this._argBuf.length;
        this._argBuf += `${arg}\0`;
      }
    }

    // Set env.
    {
      let pairs = Object.entries(env);

      this._envOffsets = new Uint32Array(pairs.length);
      this._envBuf = '';

      for (let [i, [key, value]] of pairs.entries()) {
        this._envOffsets[i] = this._envBuf.length;
        this._envBuf += `${key}=${value}\0`;
      }
    }

    this._stdOut = stdout;
    this._stdErr = stderr;
  }

  memory: WebAssembly.Memory | undefined;

  private _getBuffer() {
    let { memory } = this;
    if (!memory) {
      throw new Error('Memory not yet initialised.');
    }
    return memory.buffer;
  }

  private _getFileStat(file: File | undefined, filestatPtr: ptr<filestat_t>) {
    let filestat = filestat_t.get(this._getBuffer(), filestatPtr);
    filestat.dev = 0n;
    filestat.ino = 0n; // TODO
    filestat.filetype = file ? FileType.RegularFile : FileType.Directory;
    filestat.nlink = 0;
    // https://github.com/DefinitelyTyped/DefinitelyTyped/issues/30471#issuecomment-480900510
    if (file) {
      filestat.size = BigInt(file.size);
      filestat.accessTime = filestat.modTime = filestat.changeTime =
        BigInt(file.lastModified) * 1_000_000n;
    } else {
      filestat.size = filestat.accessTime = filestat.modTime = filestat.changeTime = 0n;
    }
  }

  getWasiImports(): {
    [key: string]: (...args: any[]) => void | E | Promise<void | E>;
  } {
    return {
      fd_prestat_get: (fd: fd_t, prestatPtr: ptr<prestat_t>) => {
        if (fd !== PREOPEN_FD) {
          return E.BADF;
        }
        let prestat = prestat_t.get(this._getBuffer(), prestatPtr);
        prestat.type = PreOpenType.Dir;
        prestat.nameLen = PREOPEN.length;
      },
      fd_prestat_dir_name: (
        fd: fd_t,
        pathPtr: ptr<string>,
        pathLen: number
      ) => {
        if (fd != PREOPEN_FD) {
          return E.BADF;
        }
        string.set(this._getBuffer(), pathPtr, PREOPEN, pathLen);
      },
      environ_sizes_get: (countPtr: ptr<number>, sizePtr: ptr<number>) => {
        size_t.set(this._getBuffer(), countPtr, this._envOffsets.length);
        size_t.set(this._getBuffer(), sizePtr, this._envBuf.length);
      },
      environ_get: (
        environPtr: ptr<Uint32Array>,
        environBufPtr: ptr<string>
      ) => {
        new Uint32Array(
          this._getBuffer(),
          environPtr,
          this._envOffsets.length
        ).set(this._envOffsets.map(offset => environBufPtr + offset));
        string.set(this._getBuffer(), environBufPtr, this._envBuf);
      },
      args_sizes_get: (argcPtr: ptr<number>, argvBufSizePtr: ptr<number>) => {
        size_t.set(this._getBuffer(), argcPtr, this._argOffsets.length);
        size_t.set(this._getBuffer(), argvBufSizePtr, this._argBuf.length);
      },
      args_get: (argvPtr: ptr<Uint32Array>, argvBufPtr: ptr<string>) => {
        new Uint32Array(
          this._getBuffer(),
          argvPtr,
          this._argOffsets.length
        ).set(this._argOffsets.map(offset => argvBufPtr + offset));
        string.set(this._getBuffer(), argvBufPtr, this._argBuf);
      },
      proc_exit: (code: number) => {
        if (code != 0) {
          this._stdErr.write(
            new TextEncoder().encode(`Exited with code ${code}.\n`)
          );
        }
        throw EXIT;
      },
      random_get: (bufPtr: ptr<Uint8Array>, bufLen: number) => {
        crypto.getRandomValues(
          new Uint8Array(this._getBuffer(), bufPtr, bufLen)
        );
      },
      path_open: async (
        dirFd: fd_t,
        dirFlags: number,
        pathPtr: ptr<string>,
        pathLen: number,
        oFlags: OpenFlags,
        fsRightsBase: bigint,
        fsRightsInheriting: bigint,
        fsFlags: FdFlags,
        fdPtr: ptr<fd_t>
      ) => {
        if (fsFlags != 0) {
          console.warn(`fsFlags are not implemented.`);
          return E.INVAL;
        }
        fd_t.set(
          this._getBuffer(),
          fdPtr,
          await this._openFiles.open(
            this._resolvePath(dirFd, pathPtr, pathLen),
            oFlags
          )
        );
      },
      fd_close: (fd: fd_t) => {
        this._openFiles.close(fd);
      },
      fd_read: async (
        fd: fd_t,
        iovsPtr: ptr<iovec_t>,
        iovsLen: number,
        nreadPtr: ptr<number>
      ) => {
        let maybeFile = this._openFiles.get(fd);
        if (!maybeFile) {
          return E.BADF;
        }
        if (!maybeFile.isFile) {
          return E.ISDIR;
        }
        let openFile = maybeFile;
        await this._forEachIoVec(iovsPtr, iovsLen, nreadPtr, async buf => {
          let chunk = await openFile.read(buf.length);
          buf.set(chunk);
          return chunk.length;
        });
      },
      fd_write: async (
        fd: fd_t,
        iovsPtr: ptr<iovec_t>,
        iovsLen: number,
        nwrittenPtr: ptr<number>
      ) => {
        let write: (data: Uint8Array) => Promise<number>;
        switch (fd) {
          case 1: {
            write = async data => {
              await this._stdOut.write(data);
              return data.length;
            };
            break;
          }
          case 2: {
            write = async data => {
              await this._stdErr.write(data);
              return data.length;
            };
            break;
          }
          default: {
            let maybeFile = this._openFiles.get(fd);
            if (!maybeFile) {
              return E.BADF;
            }
            if (!maybeFile.isFile) {
              return E.ISDIR;
            }
            let openFile = maybeFile;
            write = async data => {
              await openFile.write(data);
              return data.length;
            };
            break;
          }
        }
        await this._forEachIoVec(iovsPtr, iovsLen, nwrittenPtr, write);
      },
      fd_fdstat_get: async (fd: fd_t, fdstatPtr: ptr<fdstat_t>) => {
        let openFile = this._openFiles.get(fd);
        if (!openFile) {
          return E.BADF;
        }
        let fdstat = fdstat_t.get(this._getBuffer(), fdstatPtr);
        fdstat.filetype = openFile.isFile
          ? FileType.RegularFile
          : FileType.Directory;
        fdstat.flags = 0;
        fdstat.rightsBase = -1n;
        fdstat.rightsInheriting = -1n;
      },
      path_create_directory: async (
        dirFd: fd_t,
        pathPtr: ptr<string>,
        pathLen: number
      ) => {
        await this._openFiles.getFileOrDir(
          this._resolvePath(dirFd, pathPtr, pathLen),
          FileOrDir.Dir,
          OpenFlags.Create | OpenFlags.Directory | OpenFlags.Exclusive
        );
      },
      path_rename: async (
        oldDirFd: fd_t,
        oldPathPtr: ptr<string>,
        oldPathLen: number,
        newDirFd: fd_t,
        newPathPtr: ptr<string>,
        newPathLen: number
      ) => unimplemented(),
      path_remove_directory: (
        dirFd: fd_t,
        pathPtr: ptr<string>,
        pathLen: number
      ) => unimplemented(),
      fd_readdir: async (
        fd: fd_t,
        bufPtr: ptr<dirent_t>,
        bufLen: number,
        cookie: bigint,
        bufUsedPtr: ptr<number>
      ) => {
        const initialBufPtr = bufPtr;
        let openFile = this._openFiles.get(fd);
        if (!openFile) {
          return E.BADF;
        }
        if (openFile.isFile) {
          return E.NOTDIR;
        }
        let counter = 0n;
        for await (let item of openFile.getEntries()) {
          if (counter++ < cookie) {
            continue;
          }
          let itemSize = dirent_t.size + item.name.length;
          if (bufLen < itemSize) {
            break;
          }
          let dirent = dirent_t.get(this._getBuffer(), bufPtr);
          dirent.next = ++cookie;
          dirent.ino = 0n; // TODO
          dirent.nameLen = item.name.length;
          dirent.type = item.isDirectory
            ? FileType.Directory
            : FileType.RegularFile;
          string.set(
            this._getBuffer(),
            (bufPtr + dirent_t.size) as ptr<string>,
            item.name
          );
          bufPtr = (bufPtr + itemSize) as ptr<dirent_t>;
          bufLen -= itemSize;
        }
        size_t.set(this._getBuffer(), bufUsedPtr, bufPtr - initialBufPtr);
      },
      path_readlink: (
        dirFd: fd_t,
        pathPtr: number,
        pathLen: number,
        bufPtr: number,
        bufLen: number,
        bufUsedPtr: number
      ) => unimplemented(),
      path_filestat_get: async (
        dirFd: fd_t,
        flags: any,
        pathPtr: ptr<string>,
        pathLen: number,
        filestatPtr: ptr<filestat_t>
      ) => {
        let path = this._resolvePath(dirFd, pathPtr, pathLen);
        let handle: Handle;
        try {
          handle = await this._openFiles.getFileOrDir(
            path,
            FileOrDir.File | FileOrDir.Dir
          );
        } catch {
          return E.NOENT;
        }
        return this._getFileStat(
          handle.isFile ? await handle.getFile() : undefined,
          filestatPtr
        );
      },
      fd_seek: async (
        fd: fd_t,
        offset: bigint,
        whence: Whence,
        filesizePtr: ptr<bigint>
      ) => {
        let openFile = this._openFiles.get(fd);
        if (!openFile) {
          return E.BADF;
        }
        if (!openFile.isFile) {
          return E.ISDIR;
        }
        let { size } = await openFile.getFile();
        let base: number;
        switch (whence) {
          case Whence.Current:
            base = openFile.getPosition();
            break;
          case Whence.End:
            base = size;
            break;
          case Whence.Set:
            base = 0;
            break;
        }
        let newPosition = BigInt(base) + offset;
        if (newPosition < 0 || newPosition > size) {
          // TODO: figure out if this is supposed to match relaxed
          // POSIX behaviour.
          return E.INVAL;
        }
        openFile.setPosition(Number(newPosition));
        uint64_t.set(this._getBuffer(), filesizePtr, newPosition);
      },
      fd_filestat_get: async (fd: fd_t, filestatPtr: ptr<filestat_t>) => {
        let openFile = this._openFiles.get(fd);
        if (!openFile) {
          return E.BADF;
        }
        this._getFileStat(
          openFile.isFile ? await openFile.getFile() : undefined,
          filestatPtr
        );
      },
      path_unlink_file: (dirFd: fd_t, pathPtr: ptr<string>, pathLen: number) =>
        unimplemented(),
      poll_oneoff: (
        subscriptionPtr: ptr<any>,
        eventsPtr: ptr<any>,
        subscriptionsNum: number,
        eventsNumPtr: ptr<number>
      ) => unimplemented(),
      path_link: (
        oldDirFd: fd_t,
        oldFlags: number,
        oldPathPtr: ptr<string>,
        oldPathLen: number,
        newFd: fd_t,
        newPathPtr: ptr<string>,
        newPathLen: number
      ) => unimplemented(),
      fd_datasync: async (fd: fd_t) => {
        let openFile = this._openFiles.get(fd);
        if (!openFile) {
          return E.BADF;
        }
        if (!openFile.isFile) {
          return E.ISDIR;
        }
        await openFile.flush();
      },
      fd_sync: async (fd: fd_t) => {
        let openFile = this._openFiles.get(fd);
        if (!openFile) {
          return E.BADF;
        }
        if (openFile.isFile) {
          await openFile.flush();
        }
      },
      fd_filestat_set_size: async (fd: fd_t, newSize: bigint) => {
        let openFile = this._openFiles.get(fd);
        if (!openFile) {
          return E.BADF;
        }
        if (!openFile.isFile) {
          return E.ISDIR;
        }
        await openFile.setSize(Number(newSize));
      }
    };
  }

  private _resolvePath(
    dirFd: fd_t,
    pathPtr: ptr<string>,
    pathLen: number
  ): string {
    let dir = this._openFiles.get(dirFd);
    if (!dir) {
      throw new Error('Invalid descriptor for preopened dir.');
    }
    let relativePath = string.get(this._getBuffer(), pathPtr, pathLen);
    if (relativePath.startsWith('/')) {
      return relativePath;
    }
    let cwdPath = dir.path.slice(1);
    let cwdParts = cwdPath ? cwdPath.split('/') : [];
    for (let item of relativePath.split('/')) {
      if (item === '..') {
        cwdParts.pop();
      } else if (item !== '.') {
        cwdParts.push(item);
      }
    }
    return '/' + cwdParts.join('/');
  }

  private async _forEachIoVec(
    iovsPtr: ptr<iovec_t>,
    iovsLen: number,
    handledPtr: ptr<number>,
    cb: (buf: Uint8Array) => Promise<number>
  ) {
    let totalHandled = 0;
    for (let i = 0; i < iovsLen; i++) {
      let iovec = iovec_t.get(this._getBuffer(), iovsPtr);
      let buf = new Uint8Array(this._getBuffer(), iovec.bufPtr, iovec.bufLen);
      let handled = await cb(buf);
      totalHandled += handled;
      if (handled < iovec.bufLen) {
        break;
      }
      iovsPtr = (iovsPtr + iovec_t.size) as ptr<iovec_t>;
    }
    size_t.set(this._getBuffer(), handledPtr, totalHandled);
  }
}
