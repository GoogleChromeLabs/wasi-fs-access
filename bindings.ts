import { OpenFiles, PREOPEN_FD, PREOPEN } from './fileSystem.js';

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

function enumer<E extends string>(desc: {
  base: WritableType<number>;
  variants: E[];
}): WritableType<E> {
  return {
    size: desc.base.size,
    align: desc.base.align,
    get(buf, ptr) {
      let id = desc.base.get(buf, (ptr as any) as ptr<number>);
      let name = desc.variants[id];
      if (name === undefined) {
        throw new TypeError(`Invalid ID ${id}.`);
      }
      return name;
    },
    set(buf, ptr, value) {
      let id = desc.variants.indexOf(value);
      if (id === -1) {
        throw new TypeError(`Invalid variant ${value}.`);
      }
      desc.base.set(buf, (ptr as any) as ptr<number>, id);
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

const preopentype_t = enumer({
  base: int8_t,
  variants: ['dir']
});

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

const filetype_t = enumer({
  base: uint8_t,
  variants: [
    'unknown',
    'blockDevice',
    'charDevice',
    'directory',
    'regularFile',
    'socketDgram',
    'socketStream',
    'symbolicLink'
  ]
});

const fdflags_t = uint16_t;

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
  ISDIR = 31,
  NOSYS = 52,
  NOTDIR = 54
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

  getWasiImports() {
    return {
      fd_prestat_get: (fd: fd_t, prestatPtr: ptr<prestat_t>) => {
        if (fd !== PREOPEN_FD) {
          return E.BADF;
        }
        let prestat = prestat_t.get(this._getBuffer(), prestatPtr);
        prestat.type = 'dir';
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
        oFlags: any,
        fsRightsBase: bigint,
        fsRightsInheriting: bigint,
        fsFlags: any,
        fdPtr: ptr<fd_t>
      ) => {
        fd_t.set(
          this._getBuffer(),
          fdPtr,
          await this._openFiles.open(this._resolvePath(dirFd, pathPtr, pathLen))
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
        let openFile = this._openFiles.get(fd);
        if (!openFile.handle.isFile) {
          return E.ISDIR;
        }
        let file = await openFile.handle.getFile();
        await this._forEachIoVec(iovsPtr, iovsLen, nreadPtr, async buf => {
          let blob = file.slice(openFile.position, openFile.position + iovsLen);
          buf.set(new Uint8Array(await (blob as any).arrayBuffer()));
          openFile.position += blob.size;
          return blob.size;
        });
      },
      fd_write: async (
        fd: fd_t,
        iovsPtr: ptr<iovec_t>,
        iovsLen: number,
        nwrittenPtr: ptr<number>
      ) => {
        let write: (data: Uint8Array) => Promise<number>;
        let close: (() => Promise<void>) | void;
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
            let openFile = this._openFiles.get(fd);
            if (!openFile.handle.isFile) {
              return E.ISDIR;
            }
            let writer = await openFile.handle.createWriter({
              keepExistingData: true
            });
            write = async data => {
              await writer.write(openFile.position, data);
              openFile.position += data.length;
              return data.length;
            };
            close = () => writer.close();
            break;
          }
        }
        await this._forEachIoVec(iovsPtr, iovsLen, nwrittenPtr, write);
        if (close) {
          await close();
        }
      },
      fd_fdstat_get: async (fd: fd_t, fdstatPtr: ptr<fdstat_t>) => {
        let fdstat = fdstat_t.get(this._getBuffer(), fdstatPtr);
        fdstat.filetype = this._openFiles.get(fd).handle.isDirectory
          ? 'directory'
          : 'regularFile';
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
          'dir',
          true
        );
      },
      path_rename: async (
        oldDirFd: fd_t,
        oldPathPtr: ptr<string>,
        oldPathLen: number,
        newDirFd: fd_t,
        newPathPtr: ptr<string>,
        newPathLen: number
      ) => {
        return E.NOSYS;
      },
      path_remove_directory: (
        dirFd: fd_t,
        pathPtr: ptr<string>,
        pathLen: number
      ) => {
        return E.NOSYS;
      },
      fd_readdir: async (
        fd: fd_t,
        bufPtr: ptr<dirent_t>,
        bufLen: number,
        cookie: bigint,
        bufUsedPtr: ptr<number>
      ) => {
        const initialBufPtr = bufPtr;
        let openFile = this._openFiles.get(fd);
        if (!openFile.handle.isDirectory) {
          return E.NOTDIR;
        }
        let counter = 0n;
        for await (let item of openFile.handle.getEntries()) {
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
          dirent.type = item.isDirectory ? 'directory' : 'regularFile';
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
      path_readlink(
        dirFd: fd_t,
        pathPtr: number,
        pathLen: number,
        bufPtr: number,
        bufLen: number,
        bufUsedPtr: number
      ) {
        return E.NOSYS;
      },
      path_filestat_get: async (
        dirFd: fd_t,
        flags: any,
        pathPtr: ptr<string>,
        pathLen: number,
        filestatPtr: ptr<filestat_t>
      ) => {
        let path = this._resolvePath(dirFd, pathPtr, pathLen);
        let info = await this._openFiles.getFileOrDir(path, 'fileOrDir', false);
        let filestat = filestat_t.get(this._getBuffer(), filestatPtr);
        filestat.dev = 0n;
        filestat.ino = 0n; // TODO
        filestat.filetype = info.isDirectory ? 'directory' : 'regularFile';
        filestat.nlink = 0;
        // https://github.com/DefinitelyTyped/DefinitelyTyped/issues/30471#issuecomment-480900510
        if (info.isFile) {
          let file = await info.getFile();
          filestat.size = BigInt(file.size);
          filestat.accessTime = filestat.modTime = filestat.changeTime =
            BigInt(file.lastModified) * 1_000_000n;
        } else {
          filestat.size = filestat.accessTime = filestat.modTime = filestat.changeTime = 0n;
        }
      },
      fd_seek: (
        fd: fd_t,
        offset: bigint,
        whence: number,
        filesizePtr: number
      ) => {
        return E.NOSYS;
      }
    };
  }

  private _resolvePath(
    dirFd: fd_t,
    pathPtr: ptr<string>,
    pathLen: number
  ): string {
    let relativePath = string.get(this._getBuffer(), pathPtr, pathLen);
    if (relativePath.startsWith('/')) {
      return relativePath;
    }
    let cwdPath = this._openFiles.get(dirFd).path.slice(1);
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
