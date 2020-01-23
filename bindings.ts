'use strict';

import { promises as fsp } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { randomFill as _randomFill } from 'crypto';

const randomFill = promisify(_randomFill);

type ptr<T> = number & { _pointerTarget: T };

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
      let id = desc.base.get(buf, ptr as any as ptr<number>);
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
      desc.base.set(buf, ptr as any as ptr<number>, id);
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

type fd_t = number & { _name: 'fd' };
const fd_t = uint32_t as WritableType<fd_t>;

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

const PREOPEN = '/sandbox';

const enum E {
  SUCCESS = 0,
  BADF = 8
}

const PREOPEN_FD = 3 as fd_t;

module.exports = ({
  memory,
  env,
  args
}: {
  memory: WebAssembly.Memory;
  env: Record<string, string>;
  args: string[];
}) => {
  const openFiles = (() => {
    let nextFd: fd_t = PREOPEN_FD;

    type OpenFile = { handle: fsp.FileHandle; path: string };

    let openFiles = new Map<fd_t, OpenFile>();

    async function open(path: string) {
      openFiles.set(nextFd, {
        path,
        handle: await fsp.open(path, 'r')
      });
      return nextFd++ as fd_t;
    }

    open('.');

    return {
      open,
      get(fd: fd_t): OpenFile {
        let file = openFiles.get(fd);
        if (!file) {
          throw new Error('Tried to retrieve a non-existing file.');
        }
        return file;
      },
      close(fd: fd_t) {
        if (!openFiles.delete(fd)) {
          throw new Error('Tried to close a non-existing file.');
        }
      }
    };
  })();

  function resolvePath(dirFd: fd_t, pathPtr: ptr<string>, pathLen: number): string {
    return path.resolve(
      openFiles.get(dirFd).path,
      string.get(memory.buffer, pathPtr, pathLen)
    );
  }

  async function forEachIoVec(
    iovsPtr: ptr<iovec_t>,
    iovsLen: number,
    handledPtr: ptr<number>,
    cb: (buf: Uint8Array) => Promise<number>
  ) {
    let totalHandled = 0;
    for (let i = 0; i < iovsLen; i++) {
      let iovec = iovec_t.get(memory.buffer, iovsPtr);
      let buf = new Uint8Array(memory.buffer, iovec.bufPtr, iovec.bufLen);
      let handled = await cb(buf);
      totalHandled += handled;
      if (handled < iovec.bufLen) {
        break;
      }
      iovsPtr = (iovsPtr + iovec_t.size) as ptr<iovec_t>;
    }
    size_t.set(memory.buffer, handledPtr, totalHandled);
  }

  let envOffsets: number[] = [];
  let envBuf = '';

  for (let key in env) {
    envOffsets.push(envBuf.length);
    envBuf += `${key}=${env[key]}\0`;
  }

  let argOffsets: number[] = [];
  let argBuf = '';

  for (let arg of args) {
    argOffsets.push(argBuf.length);
    argBuf += `${arg}\0`;
  }

  class StdOut {
    private _buffer = '';
    private _decoder = new TextDecoder();

    constructor(private _method: (line: string) => void) {}

    async write(data: Uint8Array) {
      let lines = (
        this._buffer + this._decoder.decode(data, { stream: true })
      ).split('\n');
      this._buffer = lines.pop()!;
      for (let line of lines) {
        this._method(line);
      }
      return data.length;
    }
  }

  let stdout = new StdOut(console.log);
  let stderr = new StdOut(console.error);

  return {
    fd_prestat_get(fd: fd_t, prestatPtr: ptr<prestat_t>) {
      if (fd !== PREOPEN_FD) {
        return E.BADF;
      }
      let prestat = prestat_t.get(memory.buffer, prestatPtr);
      prestat.type = 'dir';
      prestat.nameLen = PREOPEN.length;
    },
    fd_prestat_dir_name(fd: fd_t, pathPtr: ptr<string>, pathLen: number) {
      if (fd != PREOPEN_FD) {
        return E.BADF;
      }
      string.set(memory.buffer, pathPtr, PREOPEN, pathLen);
    },
    environ_sizes_get(countPtr: ptr<number>, sizePtr: ptr<number>) {
      size_t.set(memory.buffer, countPtr, envOffsets.length);
      size_t.set(memory.buffer, sizePtr, envBuf.length);
    },
    environ_get(environPtr: ptr<Uint32Array>, environBufPtr: ptr<string>) {
      new Uint32Array(memory.buffer, environPtr, envOffsets.length).set(
        envOffsets.map(offset => environBufPtr + offset)
      );
      string.set(memory.buffer, environBufPtr, envBuf);
    },
    args_sizes_get(argcPtr: ptr<number>, argvBufSizePtr: ptr<number>) {
      size_t.set(memory.buffer, argcPtr, argOffsets.length);
      size_t.set(memory.buffer, argvBufSizePtr, argBuf.length);
    },
    args_get(argvPtr: ptr<Uint32Array>, argvBufPtr: ptr<string>) {
      new Uint32Array(memory.buffer, argvPtr, argOffsets.length).set(
        argOffsets.map(offset => argvBufPtr + offset)
      );
      string.set(memory.buffer, argvBufPtr, argBuf);
    },
    proc_exit(code: number) {
      process.exit(code);
    },
    random_get(bufPtr: ptr<Uint8Array>, bufLen: number) {
      return randomFill(new Uint8Array(memory.buffer, bufPtr, bufLen));
    },
    async path_open(
      dirFd: fd_t,
      dirFlags: number,
      pathPtr: ptr<string>,
      pathLen: number,
      oFlags: any,
      fsRightsBase: bigint,
      fsRightsInheriting: bigint,
      fsFlags: any,
      fdPtr: ptr<fd_t>
    ) {
      fd_t.set(
        memory.buffer,
        fdPtr,
        await openFiles.open(resolvePath(dirFd, pathPtr, pathLen))
      );
    },
    fd_close(fd: fd_t) {
      openFiles.close(fd);
    },
    async fd_read(
      fd: fd_t,
      iovsPtr: ptr<iovec_t>,
      iovsLen: number,
      nreadPtr: ptr<number>
    ) {
      let { handle } = openFiles.get(fd);
      await forEachIoVec(
        iovsPtr,
        iovsLen,
        nreadPtr,
        async buf => (await handle.read(buf, 0, buf.length)).bytesRead
      );
    },
    async fd_write(
      fd: fd_t,
      iovsPtr: ptr<iovec_t>,
      iovsLen: number,
      nwrittenPtr: ptr<number>
    ) {
      let write: (data: Uint8Array) => Promise<number>;
      switch (fd) {
        case 1: {
          write = data => stdout.write(data);
          break;
        }
        case 2: {
          write = data => stderr.write(data);
          break;
        }
        default: {
          let { handle } = openFiles.get(fd);
          write = async data => (await handle.write(data)).bytesWritten;
          break;
        }
      }
      await forEachIoVec(iovsPtr, iovsLen, nwrittenPtr, write);
    },
    async fd_fdstat_get(fd: fd_t, fdstatPtr: ptr<fdstat_t>) {
      let fdstat = fdstat_t.get(memory.buffer, fdstatPtr);
      fdstat.filetype = (await openFiles.get(fd).handle.stat()).isDirectory()
        ? 'directory'
        : 'regularFile';
      fdstat.flags = 0;
      fdstat.rightsBase = -1n;
      fdstat.rightsInheriting = -1n;
    },
    path_create_directory(dirFd: fd_t, pathPtr: ptr<string>, pathLen: number) {
      return fsp.mkdir(resolvePath(dirFd, pathPtr, pathLen));
    },
    async path_rename(
      oldDirFd: fd_t,
      oldPathPtr: ptr<string>,
      oldPathLen: number,
      newDirFd: fd_t,
      newPathPtr: ptr<string>,
      newPathLen: number
    ) {
      return fsp.rename(
        resolvePath(oldDirFd, oldPathPtr, oldPathLen),
        resolvePath(newDirFd, newPathPtr, newPathLen)
      );
    },
    async path_remove_directory(dirFd: fd_t, pathPtr: ptr<string>, pathLen: number) {
      fsp.rmdir(resolvePath(dirFd, pathPtr, pathLen));
    },
    async fd_readdir(
      fd: fd_t,
      bufPtr: ptr<dirent_t>,
      bufLen: number,
      cookie: bigint,
      bufUsedPtr: ptr<number>
    ) {
      const initialBufPtr = bufPtr;
      let items = (
        await fsp.readdir(openFiles.get(fd).path, { withFileTypes: true })
      ).slice(Number(cookie));
      for (let item of items) {
        let itemSize = dirent_t.size + item.name.length;
        if (bufLen < itemSize) {
          break;
        }
        let dirent = dirent_t.get(memory.buffer, bufPtr);
        dirent.next = ++cookie;
        dirent.ino = 0n; // TODO
        dirent.nameLen = item.name.length;
        dirent.type = item.isDirectory() ? 'directory' : 'regularFile';
        string.set(memory.buffer, bufPtr + dirent_t.size as ptr<string>, item.name);
        bufPtr = (bufPtr + itemSize) as ptr<dirent_t>;
        bufLen -= itemSize;
      }
      size_t.set(memory.buffer, bufUsedPtr, bufPtr - initialBufPtr);
    },
    path_readlink(
      dirFd: fd_t,
      pathPtr: number,
      pathLen: number,
      bufPtr: number,
      bufLen: number,
      bufUsedPtr: number
    ) {},
    async path_filestat_get(
      dirFd: fd_t,
      flags: any,
      pathPtr: ptr<string>,
      pathLen: number,
      filestatPtr: ptr<filestat_t>
    ) {
      let path = resolvePath(dirFd, pathPtr, pathLen);
      let info = await (fsp.stat as any)(path, { bigint: true });
      let filestat = filestat_t.get(memory.buffer, filestatPtr);
      filestat.dev = 0n;
      filestat.ino = 0n; // TODO
      filestat.filetype = info.isDirectory() ? 'directory' : 'regularFile';
      filestat.nlink = 0;
      // https://github.com/DefinitelyTyped/DefinitelyTyped/issues/30471#issuecomment-480900510
      filestat.size = (info.size as any) as bigint;
      filestat.accessTime = (info.atimeNs as any) as bigint;
      filestat.modTime = (info.mtimeNs as any) as bigint;
      filestat.changeTime = (info.ctimeNs as any) as bigint;
    },
    fd_seek(fd: fd_t, offset: bigint, whence: number, filesizePtr: number) {}
  };
};
