// Copyright 2020 Google Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { OpenFile, OpenFiles } from './fileSystem.js';
import {
  enumer,
  ptr,
  string,
  struct,
  taggedUnion,
  TargetType,
  TypeDesc,
  int8_t,
  uint8_t,
  uint16_t,
  uint32_t,
  uint64_t,
  size_t,
  inherit
} from './type-desc.js';
import { setTimeout, setImmediate } from 'node:timers/promises';

declare global {
  namespace WebAssembly {
    class Suspending {
      constructor(func: Function);
    }

    function promising<A extends any[], R>(
      func: (...args: A) => R
    ): (...args: A) => Promise<R>;
  }
}

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
  NOTEMPTY = 55,
  NOTCAPABLE = 76
}

export class ExitStatus {
  constructor(public statusCode: number) {}
}

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
export const fd_t = uint32_t as TypeDesc<fd_t>;

const iovec_t = struct({
  bufPtr: uint32_t,
  bufLen: size_t
});
type iovec_t = TargetType<typeof iovec_t>;

export const enum FileType {
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

type rights_t = bigint & { _name: 'rights' };
const rights_t = inherit<bigint, Rights>(uint64_t, Number, BigInt);

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
export type dirent_t = TargetType<typeof dirent_t>;

const device_t = uint64_t;

const linkcount_t = uint64_t;

const filesize_t = uint64_t;

export type timestamp_t = bigint & { _name: 'timestamp' };
export const timestamp_t = inherit<timestamp_t, number>(
  uint64_t as TypeDesc<timestamp_t>,
  rawNs => Number(rawNs) / 1e6,
  ms => BigInt(Math.round(ms * 1e6)) as timestamp_t
);

const filestat_t = struct({
  dev: device_t,
  ino: inode_t,
  filetype: filetype_t,
  nlink: linkcount_t,
  size: filesize_t,
  // Not mapping timestamp_t here because we don't need the ms conversion most of the time.
  accessTimeNs: uint64_t as TypeDesc<timestamp_t>,
  modTimeNs: uint64_t as TypeDesc<timestamp_t>,
  changeTimeNs: uint64_t as TypeDesc<timestamp_t>
});
export type filestat_t = TargetType<typeof filestat_t>;

const enum ClockId {
  Realtime,
  Monotonic,
  ProcessCPUTimeId,
  ThreadCPUTimeId
}
const clockid_t = enumer<ClockId>(uint32_t);

const userdata_t = uint64_t;

const enum EventType {
  Clock,
  FdRead,
  FdWrite
}
const eventtype_t = enumer<EventType>(uint8_t);

const enum SubclockFlags {
  Relative,
  Absolute
}
const subclockflags_t = enumer<SubclockFlags>(uint16_t);

const subscription_clock_t = struct({
  id: clockid_t,
  timeout: timestamp_t,
  precision: timestamp_t,
  flags: subclockflags_t
});

const subscription_fd_readwrite_t = struct({
  fd: fd_t
});

const subscription_union_t = taggedUnion({
  tag: eventtype_t,
  data: {
    [EventType.Clock]: subscription_clock_t,
    [EventType.FdRead]: subscription_fd_readwrite_t,
    [EventType.FdWrite]: subscription_fd_readwrite_t
  }
});

const subscription_t = struct({
  userdata: userdata_t,
  union: subscription_union_t
});
type subscription_t = TargetType<typeof subscription_t>;

const enum EventRwFlags {
  None,
  FdReadWriteHangup
}
const event_rw_flags_t = enumer<EventRwFlags>(uint16_t);

const event_fd_readwrite_t = struct({
  nbytes: filesize_t,
  flags: event_rw_flags_t
});

const event_t = struct({
  userdata: userdata_t,
  error: enumer<E>(uint16_t),
  type: eventtype_t,
  fd_readwrite: event_fd_readwrite_t
});
type event_t = TargetType<typeof event_t>;

export class SystemError extends Error {
  constructor(public readonly code: E) {
    super(`E${E[code]}`);
  }
}

// Special subclass of the BADF system error that indicates no more preopens.
// We reuse it to easily ignore when logging, as otherwise we'd have to warn on each app.
export class NoPreopen extends SystemError {
  constructor() {
    super(E.BADF);
  }
}

const enum Whence {
  Set,
  Current,
  End
}

export const enum OpenFlags {
  None = 0,
  Create = 1 << 0,
  Directory = 1 << 1,
  Exclusive = 1 << 2,
  Truncate = 1 << 3
}

export const enum FdFlags {
  None = 0,
  Append = 1 << 0,
  DSync = 1 << 1,
  NonBlock = 1 << 2,
  RSync = 1 << 3,
  Sync = 1 << 4
}

export const enum Rights {
  FdDatasync = 1 << 0,
  FdRead = 1 << 1,
  FdSeek = 1 << 2,
  FdFdstatSetFlags = 1 << 3,
  FdSync = 1 << 4,
  FdTell = 1 << 5,
  FdWrite = 1 << 6,
  FdAdvise = 1 << 7,
  FdAllocate = 1 << 8,
  PathCreateDirectory = 1 << 9,
  PathCreateFile = 1 << 10,
  PathLinkSource = 1 << 11,
  PathLinkTarget = 1 << 12,
  PathOpen = 1 << 13,
  FdReaddir = 1 << 14,
  PathReadlink = 1 << 15,
  PathRenameSource = 1 << 16,
  PathRenameTarget = 1 << 17,
  PathFilestatGet = 1 << 18,
  PathFilestatSetSize = 1 << 19,
  PathFilestatSetTimes = 1 << 20,
  FdFilestatGet = 1 << 21,
  FdFilestatSetSize = 1 << 22,
  FdFilestatSetTimes = 1 << 23,
  PathSymlink = 1 << 24,
  PathRemoveDirectory = 1 << 25,
  PathUnlinkFile = 1 << 26,
  PollFdReadwrite = 1 << 27,
  SockShutdown = 1 << 28,
  SockAccept = 1 << 29,
  // Custom collections

  NeedsRead = Rights.FdRead | Rights.FdReaddir,
  NeedsWrite = Rights.FdWrite |
    Rights.FdDatasync |
    Rights.FdSync |
    Rights.FdAllocate |
    Rights.FdFilestatSetSize,
  AllPath = Rights.PathCreateDirectory |
    Rights.PathCreateFile |
    Rights.PathLinkSource |
    Rights.PathLinkTarget |
    Rights.PathOpen |
    Rights.PathReadlink |
    Rights.PathRenameSource |
    Rights.PathRenameTarget |
    Rights.PathFilestatGet |
    Rights.PathFilestatSetSize |
    Rights.PathFilestatSetTimes |
    Rights.PathSymlink |
    Rights.PathRemoveDirectory |
    Rights.PathUnlinkFile,
  All = -1 // All rights, used for rightsInheriting
}

export const enum SetTimeFlags {
  None = 0,

  AccessTimeExplicit = 1 << 0,
  AccessTimeNow = 1 << 1,
  AccessTime = AccessTimeExplicit | AccessTimeNow,

  ModificationTimeExplicit = 1 << 2,
  ModificationTimeNow = 1 << 3,
  ModificationTime = ModificationTimeExplicit | ModificationTimeNow
}

function unimplemented() {
  throw new SystemError(E.NOSYS);
}

const textEncoder = new TextEncoder();

class StringCollection {
  private readonly _encoded: Uint8Array[];

  constructor(strings: string[]) {
    this._encoded = strings.map(str => textEncoder.encode(str + '\0'));
  }

  sizes_get(buf: ArrayBuffer, countPtr: ptr<number>, sizePtr: ptr<number>) {
    size_t.set(buf, countPtr, this._encoded.length);
    size_t.set(
      buf,
      sizePtr,
      this._encoded.reduce((acc, item) => acc + item.length, 0)
    );
  }

  get(buf: ArrayBuffer, offsetsPtr: ptr<Uint32Array>, ptr: ptr<string>) {
    const offsets = new Uint32Array(buf, offsetsPtr, this._encoded.length);
    const bytesView = new Uint8Array(buf);

    for (const [i, encodedStr] of this._encoded.entries()) {
      offsets[i] = ptr;
      bytesView.set(encodedStr, ptr);
      ptr = (ptr + encodedStr.length) as ptr<string>;
    }
  }
}

export { OpenFiles };

function convertCpuTime(usage: NodeJS.CpuUsage) {
  return (usage.user + usage.system) / 1000; // Convert to milliseconds
}

function getTime(id: ClockId) {
  switch (id) {
    case ClockId.Realtime:
      return Date.now();
    case ClockId.Monotonic:
      return performance.now();
    case ClockId.ProcessCPUTimeId:
      return convertCpuTime(process.cpuUsage());
    case ClockId.ThreadCPUTimeId:
      return convertCpuTime(process.threadCpuUsage());
  }
}

export default class Bindings implements AsyncDisposable {
  private readonly _openFiles = new OpenFiles();

  private readonly _args: StringCollection;

  private readonly _env: StringCollection;

  private _abortSignal: AbortSignal | undefined;

  constructor({
    args = [],
    env = [],
    abortSignal
  }: {
    args?: string[];
    env?: Record<string, string | undefined> | string[];
    abortSignal?: AbortSignal;
  } = {}) {
    this._args = new StringCollection(['wasi-app', ...args]);
    if (!Array.isArray(env)) {
      env = Object.entries(env).map(([key, value = '']) => `${key}=${value}`);
    }
    this._env = new StringCollection(env);
    this._abortSignal = abortSignal;
  }

  memory: WebAssembly.Memory | undefined;

  private _checkAbort() {
    this._abortSignal?.throwIfAborted();
  }

  private _getBuffer() {
    let { memory } = this;
    if (!memory) {
      throw new Error('Memory not yet initialised.');
    }
    return memory.buffer;
  }

  private _resolve(dirFd: fd_t, pathPtr: ptr<string>, pathLen: number) {
    return this._openFiles
      .getDir(dirFd)
      .resolve(string.get(this._getBuffer(), pathPtr, pathLen));
  }

  addPreOpen(hostPath: string, wasiPath: string) {
    return this._openFiles.addPreOpen(hostPath, wasiPath);
  }

  async _fileIO(
    fd: fd_t,
    iovsPtr: ptr<iovec_t>,
    iovsLen: number,
    nprocessedBytesPtr: ptr<number>,
    io: (file: OpenFile, bufs: Uint8Array[], offset: number) => Promise<number>,
    offset?: bigint
  ) {
    const buffer = this._getBuffer();
    const iovsRaw = new Uint32Array(buffer, iovsPtr, iovsLen * iovec_t.size);
    let iovecs = Array.from({ length: iovsLen }, (_, i) => {
      i *= 2;
      return new Uint8Array(buffer, iovsRaw[i], iovsRaw[i + 1]);
    });
    let file = this._openFiles.getFile(fd);
    let nprocessedBytes = await io(
      file,
      iovecs,
      offset !== undefined ? Number(offset) : file.position
    );
    size_t.set(this._getBuffer(), nprocessedBytesPtr, nprocessedBytes);
    if (offset === undefined) {
      file.position += nprocessedBytes;
    }
  }

  private _fileRead(
    fd: fd_t,
    iovsPtr: ptr<iovec_t>,
    iovsLen: number,
    nreadPtr: ptr<number>,
    offset?: bigint
  ): void | PromiseLike<void> {
    return this._fileIO(
      fd,
      iovsPtr,
      iovsLen,
      nreadPtr,
      (f, bufs, offset) => f.readvAt(bufs, offset),
      offset
    );
  }

  private _fileWrite(
    fd: fd_t,
    iovsPtr: ptr<iovec_t>,
    iovsLen: number,
    nwrittenPtr: ptr<number>,
    offset?: bigint
  ): void | PromiseLike<void> {
    return this._fileIO(
      fd,
      iovsPtr,
      iovsLen,
      nwrittenPtr,
      async (f, bufs, calculatedOffset) => {
        // In O_APPEND mode with an implicit offset, we need to seek to the end of the file.
        if (offset === undefined && f.fdFlags & FdFlags.Append) {
          calculatedOffset = f.position = Number((await f.stat()).size);
        }
        return f.writevAt(bufs, calculatedOffset);
      },
      offset
    );
  }

  getWasiImports() {
    // TODO: add rights checks.
    const bindings: Record<string, (...args: any[]) => void | Promise<void>> = {
      sched_yield: async () =>
        setImmediate(undefined, { signal: this._abortSignal }),
      fd_prestat_get: (fd: fd_t, prestatPtr: ptr<prestat_t>) =>
        prestat_t.set(this._getBuffer(), prestatPtr, {
          type: PreOpenType.Dir,
          nameLen: Buffer.byteLength(this._openFiles.getPreOpen(fd).wasiPath)
        }),
      fd_prestat_dir_name: (fd: fd_t, pathPtr: ptr<string>, pathLen: number) =>
        string.set(
          this._getBuffer(),
          pathPtr,
          this._openFiles.getPreOpen(fd).wasiPath,
          pathLen
        ),
      environ_sizes_get: (countPtr: ptr<number>, sizePtr: ptr<number>) =>
        this._env.sizes_get(this._getBuffer(), countPtr, sizePtr),
      environ_get: (environPtr: ptr<Uint32Array>, environBufPtr: ptr<string>) =>
        this._env.get(this._getBuffer(), environPtr, environBufPtr),
      args_sizes_get: (argcPtr: ptr<number>, argvBufSizePtr: ptr<number>) =>
        this._args.sizes_get(this._getBuffer(), argcPtr, argvBufSizePtr),
      args_get: (argvPtr: ptr<Uint32Array>, argvBufPtr: ptr<string>) =>
        this._args.get(this._getBuffer(), argvPtr, argvBufPtr),
      proc_exit: (code: number) => {
        throw new ExitStatus(code);
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
        fsRightsBase: rights_t,
        fsRightsInheriting: rights_t,
        fdFlags: FdFlags,
        fdPtr: ptr<fd_t>
      ) =>
        fd_t.set(
          this._getBuffer(),
          fdPtr,
          await this._openFiles.open(
            this._resolve(dirFd, pathPtr, pathLen),
            oFlags,
            fdFlags,
            rights_t.fromRaw(fsRightsBase),
            rights_t.fromRaw(fsRightsInheriting)
          )
        ),
      fd_fdstat_set_flags: (fd: fd_t, flags: FdFlags) => {
        this._openFiles.get(fd).fdFlags = flags;
      },
      fd_close: async (fd: fd_t) => this._openFiles.close(fd),
      fd_pread: async (
        fd: fd_t,
        iovsPtr: ptr<iovec_t>,
        iovsLen: number,
        offset: bigint,
        nreadPtr: ptr<number>
      ) => this._fileRead(fd, iovsPtr, iovsLen, nreadPtr, offset),
      fd_read: async (
        fd: fd_t,
        iovsPtr: ptr<iovec_t>,
        iovsLen: number,
        nreadPtr: ptr<number>
      ) => this._fileRead(fd, iovsPtr, iovsLen, nreadPtr),
      fd_pwrite: async (
        fd: fd_t,
        iovsPtr: ptr<iovec_t>,
        iovsLen: number,
        offset: bigint,
        nwrittenPtr: ptr<number>
      ) => this._fileWrite(fd, iovsPtr, iovsLen, nwrittenPtr, offset),
      fd_write: async (
        fd: fd_t,
        iovsPtr: ptr<iovec_t>,
        iovsLen: number,
        nwrittenPtr: ptr<number>
      ) => this._fileWrite(fd, iovsPtr, iovsLen, nwrittenPtr),
      fd_fdstat_get: async (fd: fd_t, fdstatPtr: ptr<fdstat_t>) => {
        let file = this._openFiles.get(fd);
        let stats = await file.stat();
        fdstat_t.set(this._getBuffer(), fdstatPtr, {
          filetype: stats.filetype,
          flags: file.fdFlags,
          rightsBase: ~(stats.filetype === FileType.Directory
            ? Rights.FdSeek
            : Rights.AllPath),
          rightsInheriting:
            stats.filetype === FileType.Directory ? Rights.All : ~Rights.AllPath
        });
      },
      path_create_directory: async (
        dirFd: fd_t,
        pathPtr: ptr<string>,
        pathLen: number
      ) => this._openFiles.createDir(this._resolve(dirFd, pathPtr, pathLen)),
      path_rename: async (
        oldDirFd: fd_t,
        oldPathPtr: ptr<string>,
        oldPathLen: number,
        newDirFd: fd_t,
        newPathPtr: ptr<string>,
        newPathLen: number
      ) =>
        this._openFiles.rename(
          this._resolve(oldDirFd, oldPathPtr, oldPathLen),
          this._resolve(newDirFd, newPathPtr, newPathLen)
        ),
      path_remove_directory: async (
        dirFd: fd_t,
        pathPtr: ptr<string>,
        pathLen: number
      ) => {
        let path = this._resolve(dirFd, pathPtr, pathLen);
        try {
          await this._openFiles.rmDir(path);
        } catch (e: any) {
          if (process.platform === 'win32' && e.code === 'ENOENT') {
            // Fixup for https://github.com/nodejs/node/issues/18014.
            // Try to stat the path to see if it actually exists.
            // If this fails, it will fail with ENOENT again, which is fine, but
            // if it doesn't, it means we should throw E.NOTDIR instead.
            await this._openFiles.stat(path);
            throw new SystemError(E.NOTDIR);
          }
          throw e;
        }
      },
      fd_readdir: async (
        fd: fd_t,
        bufPtr: ptr<dirent_t | string>,
        bufLen: number,
        next: bigint,
        bufUsedPtr: ptr<number>
      ) => {
        const initialBufPtr = bufPtr;
        let openDir = this._openFiles.getDir(fd);
        let buf = this._getBuffer();
        for await (let entry of openDir.getEntries(Number(next))) {
          this._checkAbort();
          let { name } = entry;
          let nameLen = Buffer.byteLength(name);
          let dirEnt: dirent_t = {
            next: ++next,
            ino: entry.ino,
            nameLen,
            type: entry.type
          };
          if (bufLen < dirent_t.size) {
            // Insufficient space, but we must write as much as we can.
            // Do this by writing the whole thing into a temporary buffer.
            let tempBuf = new Uint8Array(dirent_t.size);
            dirent_t.set(tempBuf.buffer, 0 as ptr<dirent_t>, dirEnt);
            new Uint8Array(buf, bufPtr).set(tempBuf.subarray(0, bufLen));
            // Tell consumer that we filled the entire buffer so it's not an EOF.
            bufPtr = (bufPtr + bufLen) as ptr<dirent_t>;
            break;
          }
          dirent_t.set(buf, bufPtr as ptr<dirent_t>, dirEnt);
          bufPtr = (bufPtr + dirent_t.size) as ptr<dirent_t>;
          bufLen -= dirent_t.size;
          try {
            string.set(
              buf,
              bufPtr as ptr<string>,
              name,
              // Don't overflow the buffer.
              Math.min(nameLen, bufLen)
            );
          } catch (e) {
            if (e instanceof RangeError) {
              // If the string doesn't fit, we just stop here.
              // Tell consumer that we filled the entire buffer so it's not an EOF.
              bufPtr = (bufPtr + bufLen) as ptr<dirent_t>;
              break;
            }
            throw e;
          }
          bufPtr = (bufPtr + nameLen) as ptr<dirent_t>;
          bufLen -= nameLen;
        }
        size_t.set(buf, bufUsedPtr, bufPtr - initialBufPtr);
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
      ) =>
        filestat_t.set(
          this._getBuffer(),
          filestatPtr,
          await this._openFiles.stat(this._resolve(dirFd, pathPtr, pathLen))
        ),
      fd_seek: async (
        fd: fd_t,
        offset: bigint,
        whence: Whence,
        filesizePtr: ptr<bigint>
      ) => {
        let openFile = this._openFiles.getFile(fd);
        let pos: number;
        switch (whence) {
          case Whence.Current:
            pos = openFile.position;
            break;
          case Whence.End:
            pos = Number((await openFile.stat()).size);
            break;
          case Whence.Set:
            pos = 0;
            break;
        }
        pos += Number(offset);
        if (pos < 0) {
          throw new SystemError(E.INVAL);
        }
        openFile.position = pos;
        uint64_t.set(this._getBuffer(), filesizePtr, BigInt(pos));
      },
      fd_tell: (fd: fd_t, offsetPtr: ptr<bigint>) =>
        uint64_t.set(
          this._getBuffer(),
          offsetPtr,
          BigInt(this._openFiles.getFile(fd).position)
        ),
      fd_filestat_get: async (fd: fd_t, filestatPtr: ptr<filestat_t>) =>
        filestat_t.set(
          this._getBuffer(),
          filestatPtr,
          await this._openFiles.get(fd).stat()
        ),
      path_unlink_file: async (
        dirFd: fd_t,
        pathPtr: ptr<string>,
        pathLen: number
      ) => {
        let path = this._resolve(dirFd, pathPtr, pathLen);
        if (path.endsWith('/')) {
          // If the path ends with a slash, throw an error to appease WASI.
          throw new SystemError(
            (await this._openFiles.stat(path)).filetype === FileType.Directory
              ? E.ISDIR
              : E.NOTDIR
          );
        }
        return this._openFiles.rmFile(path);
      },
      poll_oneoff: async (
        subscriptionsPtr: ptr<subscription_t[]>,
        eventsPtr: ptr<event_t>,
        subscriptionsNum: number,
        eventsNumPtr: ptr<number>
      ) => {
        if (subscriptionsNum === 0) {
          throw new RangeError('Polling requires at least one subscription');
        }
        let eventsNum = 0;
        // Create localized polling abort controller.
        const abortController = new AbortController();
        const { signal } = abortController;
        // Propagate the outer abort signal to the polling.
        this._abortSignal?.addEventListener(
          'abort',
          () => abortController.abort(),
          // Make sure this event listener is removed whenever we're done with the polling
          // (including if it aborted itself once already).
          { signal }
        );
        const buf = this._getBuffer();
        try {
          await Promise.race(
            Array.from(
              { length: subscriptionsNum },
              async (_, i): Promise<void> => {
                let { userdata, union } = subscription_t.get(
                  buf,
                  (subscriptionsPtr +
                    i * subscription_t.size) as ptr<subscription_t>
                );
                switch (union.tag) {
                  case EventType.Clock: {
                    let timeout = Number(union.data.timeout) / 1_000_000;
                    if (union.data.flags === SubclockFlags.Absolute) {
                      timeout -= getTime(union.data.id);
                    }
                    // This is not completely correct, since setTimeout doesn't give the required precision for monotonic clock.
                    await setTimeout(timeout, undefined, { signal });
                    break;
                  }
                  case EventType.FdRead:
                  case EventType.FdWrite: {
                    let { fd } = union.data;
                    // Just verify that the file descriptor is valid.
                    this._openFiles.getFile(fd);
                    // Other than that, even WASI spec says it should resolve immediately for regular files.
                    // I guess it's merely here for future-proofing.
                    break;
                  }
                  default:
                    unimplemented();
                }
                // Note: doing this way is better than bare `Promise.race()` because it gives several events a chance
                // to be resolved simultaneously.
                Object.assign(event_t.get(buf, eventsPtr), {
                  error: E.SUCCESS,
                  type: union.tag,
                  userdata,
                  fd_readwrite: {
                    nbytes: 1n,
                    flags: EventRwFlags.None
                  }
                });
                eventsNum++;
                eventsPtr = (eventsPtr + event_t.size) as ptr<event_t>;
              }
            )
          );
        } finally {
          // Clean up - remove the listener, stop timers.
          abortController.abort();
        }
        size_t.set(buf, eventsNumPtr, eventsNum);
      },
      path_link: (
        oldDirFd: fd_t,
        oldFlags: number,
        oldPathPtr: ptr<string>,
        oldPathLen: number,
        newFd: fd_t,
        newPathPtr: ptr<string>,
        newPathLen: number
      ) => unimplemented(),
      fd_datasync: (fd: fd_t) => this._openFiles.getFile(fd).datasync(),
      fd_sync: async (fd: fd_t) => this._openFiles.getFile(fd).sync(),
      fd_filestat_set_size: async (fd: fd_t, newSize: bigint) =>
        this._openFiles.getFile(fd).setSize(Number(newSize)),
      fd_renumber: async (from: fd_t, to: fd_t) =>
        this._openFiles.renumber(from, to),
      path_symlink: (oldPath: ptr<string>, fd: fd_t, newPath: ptr<string>) =>
        unimplemented(),
      clock_time_get: (
        id: ClockId,
        precision: timestamp_t,
        resultPtr: ptr<timestamp_t>
      ) => timestamp_t.set(this._getBuffer(), resultPtr, getTime(id)),
      clock_res_get: (id: ClockId, resultPtr: ptr<timestamp_t>) =>
        timestamp_t.set(this._getBuffer(), resultPtr, 1 /* ms */),
      fd_allocate: (fd: fd_t, offset: bigint, len: bigint) => unimplemented(),
      fd_advise: (fd: fd_t, offset: bigint, len: bigint, advice: number) =>
        unimplemented(),
      fd_filestat_set_times: async (
        fd: fd_t,
        newAccessTimeNs: timestamp_t,
        newModTimeNs: timestamp_t,
        flags: SetTimeFlags
      ) =>
        this._openFiles
          .getFile(fd)
          .setTimes(flags, newAccessTimeNs, newModTimeNs),
      path_filestat_set_times: async (
        dirFd: fd_t,
        lookupFlags: number,
        pathPtr: ptr<string>,
        pathLen: number,
        newAccessTimeNs: timestamp_t,
        newModTimeNs: timestamp_t,
        flags: SetTimeFlags
      ) =>
        this._openFiles.setTimes(
          this._resolve(dirFd, pathPtr, pathLen),
          flags,
          newAccessTimeNs,
          newModTimeNs
        ),
      fd_fdstat_set_rights: (
        fd: fd_t,
        rightsBase: bigint,
        rightsInheriting: bigint
      ) => unimplemented()
    };

    // AsyncFunction is not exposed in the global scope, so we need to get it manually.
    const AsyncFunction = (async () => {}).constructor as typeof Function;

    return new Proxy(bindings, {
      get: (target, name, receiver) => {
        let value = Reflect.get(target, name, receiver);
        if (!(typeof name === 'string' && typeof value === 'function')) {
          return value;
        }
        // We intentionally use explicit `async` syntax on async functions to make them easier to detect.
        if (value instanceof AsyncFunction) {
          return new WebAssembly.Suspending(async (...args: any[]) => {
            try {
              await value(...args);
              this._checkAbort();
              return E.SUCCESS;
            } catch (err) {
              return this._translateError(err);
            }
          });
        } else {
          return (...args: any[]) => {
            try {
              const result = value(...args);
              // Ensure we didn't miss any async functions.
              if (result instanceof Promise) {
                throw new Error(`Unexpected async function ${name.toString()}`);
              }
              this._checkAbort();
              return E.SUCCESS;
            } catch (err) {
              return this._translateError(err);
            }
          };
        }
      }
    });
  }

  setExports(exports: WebAssembly.Exports) {
    this.memory = exports.memory as WebAssembly.Memory;
  }

  async run(module: WebAssembly.Module): Promise<number> {
    let { exports } = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: this.getWasiImports()
    });
    this.setExports(exports);
    try {
      await WebAssembly.promising(exports._start as () => void)();
      return 0;
    } catch (err) {
      if (err instanceof ExitStatus) {
        if (this.lastError !== undefined) {
          console.error('Last bindings error:', this.lastError);
        }
        return err.statusCode;
      }
      if (err instanceof WebAssembly.RuntimeError) {
        // This is a runtime error, log and treat as SIGABRT.
        console.error(err);
        return 134;
      }
      // Anything else is an unexpected error, likely in the implementation.
      throw err;
    }
  }

  _getForTesting(fd: fd_t) {
    return this._openFiles.get(fd);
  }

  [Symbol.asyncDispose]() {
    return this._openFiles[Symbol.asyncDispose]();
}

  lastError: any;

  private _translateError(err: any): E {
  let code;
  if (err instanceof SystemError) {
    ({ code } = err);
    } else if (err instanceof DOMException) {
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
    } else if (err instanceof TypeError || err instanceof RangeError) {
      code = E.INVAL;
  } else if (typeof err.code === 'string') {
    // https://nodejs.org/api/errors.html#errorcode
    switch (err.code) {
      case 'EACCES':
      case 'EPERM':
        code = E.ACCES;
        break;
      case 'EEXIST':
        code = E.EXIST;
        break;
      case 'EISDIR':
        code = E.ISDIR;
        break;
      case 'ENOENT':
        code = E.NOENT;
        break;
      case 'ENOTDIR':
        code = E.NOTDIR;
        break;
      case 'ENOTEMPTY':
        code = E.NOTEMPTY;
        break;
    }
  }
  if (code) {
      // Before returning the code, store the original error details.
    // Ignore the preopen error we expect in all apps.
    if (!(err instanceof NoPreopen)) {
        this.lastError = err;
    }
    return code;
  } else {
    // Not something we can map to a WASI error code, must be a critical error.
    throw err;
    }
  }
}
