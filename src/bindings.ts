import { OpenFiles, FileOrDir, FIRST_PREOPEN_FD } from './fileSystem.js';

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
  // All the properties are same as for the underlying number, this wrapper is only useful at typechecking level.
  return base as WritableType<E>;
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

const enum ClockId {
  Realtime,
  Monotonic,
  ProcessCPUTimeId,
  ThreadCPUTimeId
}
const clockid_t = enumer<ClockId>(uint32_t);

export enum E {
  SUCCESS = 0,
  ACCES = 2,
  BADF = 8,
  CANCELED = 11,
  EXIST = 20,
  INVAL = 28,
  ISDIR = 31,
  NOENT = 44,
  NOSYS = 52,
  NOTDIR = 54,
  NOTEMPTY = 55
}

export class SystemError extends Error {
  constructor(public readonly code: E, public readonly value?: any) {
    super(`E${E[code]}` + (value ? ` with value ${value}` : ''));
  }
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

interface In {
  read(len: number): Uint8Array | Promise<Uint8Array>;
}

interface Out {
  write(data: Uint8Array): void | Promise<void>;
}

export const bufferIn = (buffer: Uint8Array): In => {
  return {
    read: len => {
      let chunk = buffer.subarray(0, len);
      buffer = buffer.subarray(len);
      return chunk;
    }
  };
};

export const stringOut = (writeStr: (chunk: string) => void): Out => {
  let decoder = new TextDecoder();

  return {
    write: data => {
      writeStr(decoder.decode(data, { stream: true }));
    }
  };
};

export const lineOut = (writeLn: (chunk: string) => void): Out => {
  let lineBuf = '';

  return stringOut(chunk => {
    lineBuf += chunk;
    let lines = lineBuf.split('\n');
    lineBuf = lines.pop()!;
    for (let line of lines) {
      writeLn(line);
    }
  });
};

function unimplemented() {
  throw new SystemError(E.NOSYS);
}

export default class Bindings {
  private _openFiles: OpenFiles;

  private _argOffsets: Uint32Array;
  private _argBuf: string;

  private _envOffsets: Uint32Array;
  private _envBuf: string;

  private _stdIn: In;
  private _stdOut: Out;
  private _stdErr: Out;

  constructor({
    preOpen,
    stdin = { read: () => new Uint8Array() },
    stdout = lineOut(console.log),
    stderr = lineOut(console.error),
    args = [],
    env = {}
  }: {
    preOpen: Record<string, FileSystemDirectoryHandle>;
    stdin?: In;
    stdout?: Out;
    stderr?: Out;
    args?: string[];
    env?: Record<string, string>;
  }) {
    this._openFiles = new OpenFiles(preOpen);

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

    this._stdIn = stdin;
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
    const bindings = {
      fd_prestat_get: (fd: fd_t, prestatPtr: ptr<prestat_t>) => {
        let prestat = prestat_t.get(this._getBuffer(), prestatPtr);
        prestat.type = PreOpenType.Dir;
        prestat.nameLen = this._openFiles.getPreOpen(fd).path.length;
      },
      fd_prestat_dir_name: (
        fd: fd_t,
        pathPtr: ptr<string>,
        pathLen: number
      ) => {
        string.set(
          this._getBuffer(),
          pathPtr,
          this._openFiles.getPreOpen(fd).path,
          pathLen
        );
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
          unimplemented();
        }
        fd_t.set(
          this._getBuffer(),
          fdPtr,
          await this._openFiles.open(
            this._openFiles.getPreOpen(dirFd),
            string.get(this._getBuffer(), pathPtr, pathLen),
            oFlags
          )
        );
      },
      fd_fdstat_set_flags: (fd: fd_t, flags: FdFlags) => unimplemented(),
      fd_close: (fd: fd_t) => this._openFiles.close(fd),
      fd_read: async (
        fd: fd_t,
        iovsPtr: ptr<iovec_t>,
        iovsLen: number,
        nreadPtr: ptr<number>
      ) => {
        let read: (len: number) => Promise<Uint8Array>;
        if (fd === 0) {
          read = async len => this._stdIn.read(len);
        } else {
          let openFile = this._openFiles.get(fd).asFile();
          read = len => openFile.read(len);
        }
        await this._forEachIoVec(iovsPtr, iovsLen, nreadPtr, async buf => {
          let chunk = await read(buf.length);
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
        let out: Out;
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
        await this._forEachIoVec(iovsPtr, iovsLen, nwrittenPtr, async data => {
          await out.write(data);
          return data.length;
        });
      },
      fd_fdstat_get: async (fd: fd_t, fdstatPtr: ptr<fdstat_t>) => {
        let fdstat = fdstat_t.get(this._getBuffer(), fdstatPtr);
        fdstat.rightsBase = /* anything */ -1n;
        fdstat.rightsInheriting = /* anything but symlink */ ~(1n << 24n);
        fdstat.flags = 0;
        if (fd < FIRST_PREOPEN_FD) {
          fdstat.filetype = FileType.CharacterDevice;
        } else {
          fdstat.filetype = this._openFiles.get(fd).isFile
            ? FileType.RegularFile
            : FileType.Directory;
        }
      },
      path_create_directory: async (
        dirFd: fd_t,
        pathPtr: ptr<string>,
        pathLen: number
      ) =>
        this._openFiles
          .getPreOpen(dirFd)
          .getFileOrDir(
            string.get(this._getBuffer(), pathPtr, pathLen),
            FileOrDir.Dir,
            OpenFlags.Create | OpenFlags.Directory | OpenFlags.Exclusive
          )
          .then(() => {}),
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
      ) =>
        this._openFiles
          .getPreOpen(dirFd)
          .delete(string.get(this._getBuffer(), pathPtr, pathLen)),
      fd_readdir: async (
        fd: fd_t,
        bufPtr: ptr<dirent_t>,
        bufLen: number,
        cookie: bigint,
        bufUsedPtr: ptr<number>
      ) => {
        const initialBufPtr = bufPtr;
        let openDir = this._openFiles.get(fd).asDir();
        let counter = 0n;
        for await (let item of openDir.getEntries()) {
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
        let handle = await this._openFiles
          .getPreOpen(dirFd)
          .getFileOrDir(
            string.get(this._getBuffer(), pathPtr, pathLen),
            FileOrDir.Any
          );
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
        let openFile = this._openFiles.get(fd).asFile();
        let { size } = await openFile.getFile();
        let base: number;
        switch (whence) {
          case Whence.Current:
            base = openFile.position;
            break;
          case Whence.End:
            base = size;
            break;
          case Whence.Set:
            base = 0;
            break;
        }
        openFile.position = base + Number(offset);
        uint64_t.set(this._getBuffer(), filesizePtr, BigInt(openFile.position));
      },
      fd_tell: (fd: fd_t, offsetPtr: ptr<bigint>) => {
        uint64_t.set(
          this._getBuffer(),
          offsetPtr,
          BigInt(this._openFiles.get(fd).asFile().position)
        );
      },
      fd_filestat_get: async (fd: fd_t, filestatPtr: ptr<filestat_t>) => {
        let openFile = this._openFiles.get(fd);
        this._getFileStat(
          openFile.isFile ? await openFile.getFile() : undefined,
          filestatPtr
        );
      },
      path_unlink_file: (dirFd: fd_t, pathPtr: ptr<string>, pathLen: number) =>
        this._openFiles
          .getPreOpen(dirFd)
          .delete(string.get(this._getBuffer(), pathPtr, pathLen)),
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
      fd_datasync: (fd: fd_t) => this._openFiles.get(fd).asFile().flush(),
      fd_sync: async (fd: fd_t) => {
        let openFile = this._openFiles.get(fd);
        if (openFile.isFile) {
          await openFile.flush();
        }
      },
      fd_filestat_set_size: async (fd: fd_t, newSize: bigint) =>
        this._openFiles.get(fd).asFile().setSize(Number(newSize)),
      fd_renumber: (from: fd_t, to: fd_t) => unimplemented(),
      path_symlink: (oldPath: ptr<string>, fd: fd_t, newPath: ptr<string>) =>
        unimplemented(),
      clock_time_get: (
        id: ClockId,
        precision: bigint,
        resultPtr: ptr<bigint>
      ) => {
        let origin = id === ClockId.Realtime ? Date : performance;
        timestamp_t.set(
          this._getBuffer(),
          resultPtr,
          BigInt(Math.round(origin.now() * 1_000_000))
        );
      },
      clock_res_get: (id: ClockId, resultPtr: ptr<bigint>) => {
        timestamp_t.set(this._getBuffer(), resultPtr, /* 1ms */ 1_000_000n);
      }
    };

    return new Proxy(bindings, {
      get(target, name, receiver) {
        let value = Reflect.get(target, name, receiver);
        if (typeof name !== 'string' || typeof value !== 'function') {
          return value;
        }
        return async (...args: any[]) => {
          try {
            return (await value(...args)) ?? E.SUCCESS;
          } catch (err) {
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
            } else if (err instanceof TypeError || err instanceof RangeError) {
              console.warn(err);
              return E.INVAL;
            }
            throw err;
          }
        };
      }
    });
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
