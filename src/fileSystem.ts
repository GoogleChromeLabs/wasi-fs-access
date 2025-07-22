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

import type { BigIntStats } from 'node:fs';
import * as fs from 'node:fs';
import {
  link,
  lstat,
  lutimes,
  mkdir,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink
} from 'node:fs/promises';
import {
  fd_t,
  OpenFlags,
  SystemError,
  E,
  FdFlags,
  FileType,
  Rights,
  filestat_t,
  NoPreopen,
  timestamp_t,
  dirent_t,
  SetTimeFlags
} from './bindings.js';
import { promisify } from 'node:util';

type ResolvedPath = string & { __resolved: true };

// Note: not using fs/promises because it doesn't allow constructing file handles from raw fd, and we need some file ops for stdin/stdout/stderr.
const open = promisify(fs.open);
const readv = promisify(fs.readv);
const writev = promisify(fs.writev);
const fstat = promisify(fs.fstat);
const fdatasync = promisify(fs.fdatasync);
const fsync = promisify(fs.fsync);
const fruncate = promisify(fs.ftruncate);
const futimes = promisify(fs.futimes);
const close = promisify(fs.close);

const fsc = fs.constants;

// Unfortunately, utime doesn't support bigint, so we need to convert times to Date (milliseconds).
// This might result in a precision loss.
// See https://github.com/nodejs/node/issues/56492.
async function setTimes<T>(
  file: T,
  stat: (file: T, opts: { bigint: true }) => Promise<BigIntStats>,
  flags: SetTimeFlags,
  newAccessTime: timestamp_t,
  newModTime: timestamp_t,
  utimes: (file: T, atime: Date, mtime: Date) => Promise<void>
) {
  let { atime, mtime } = await stat(file, { bigint: true });

  let now = new Date();

  switch (flags & SetTimeFlags.AccessTime) {
    case SetTimeFlags.AccessTimeExplicit:
      atime = new Date(timestamp_t.fromRaw(newAccessTime));
      break;
    case SetTimeFlags.AccessTimeNow:
      atime = now;
      break;
    case SetTimeFlags.None:
      break;
    default:
      throw new RangeError('Invalid access time flag');
  }

  switch (flags & SetTimeFlags.ModificationTime) {
    case SetTimeFlags.ModificationTimeExplicit:
      mtime = new Date(timestamp_t.fromRaw(newModTime));
      break;
    case SetTimeFlags.ModificationTimeNow:
      mtime = now;
      break;
    case SetTimeFlags.None:
      break;
    default:
      throw new RangeError('Invalid modification time flag');
  }

  await utimes(file, atime, mtime);
}

export class OpenFile implements AsyncDisposable {
  constructor(
    private readonly hostFd: number,
    public fdFlags: FdFlags,
    public rights: Rights
  ) {}

  // Files can't have inheriting rights.
  rightsInheriting = Rights.None;

  checkRights(needRights: Rights) {
    if ((this.rights & needRights) !== needRights) {
      // If the rights are not enough, throw an error.
      throw new SystemError(E.NOTCAPABLE);
    }
  }

  static async openFile(
    hostPath: ResolvedPath,
    openFlags: OpenFlags,
    fdFlags: FdFlags,
    rights: Rights
  ) {
    // Files shouldn't have path_ rights even if manually given.
    rights &= ~Rights.AllPath;

    let nodeFlags = 0;

    if (openFlags & OpenFlags.Create) {
      nodeFlags |= fsc.O_CREAT;
    }
    if (openFlags & OpenFlags.Exclusive) {
      nodeFlags |= fsc.O_EXCL;
    }
    if (openFlags & OpenFlags.Truncate) {
      nodeFlags |= fsc.O_TRUNC;
    }

    if (fdFlags & FdFlags.DSync) {
      nodeFlags |= fsc.O_DSYNC;
    }
    if (fdFlags & FdFlags.NonBlock) {
      nodeFlags |= fsc.O_NONBLOCK;
    }
    if (fdFlags & (FdFlags.Sync | FdFlags.RSync)) {
      nodeFlags |= fsc.O_SYNC;
    }

    if (rights & Rights.NeedsRead) {
      nodeFlags |= rights & Rights.NeedsWrite ? fsc.O_RDWR : fsc.O_RDONLY;
    } else if (rights & Rights.NeedsWrite) {
      nodeFlags |= fsc.O_WRONLY;
    }

    // Note: do not use O_APPEND, as it opens us to kernel differences and shenanigans.
    // We already need to do our own position tracking anyway (since Node.js doesn't expose it), so we can handle appending ourselves.

    return new OpenFile(await open(hostPath, nodeFlags), fdFlags, rights);
  }

  private _position: number = 0;

  get position() {
    return this._position;
  }

  set position(value: number) {
    if (value < 0) {
      throw new RangeError('Position cannot be negative');
    }
    this._position = value;
  }

  async readvAt(bufs: Uint8Array[], position: number): Promise<number> {
    const { bytesRead } = await readv(this.hostFd, bufs, position);
    return bytesRead;
  }

  async writevAt(bufs: Uint8Array[], position: number): Promise<number> {
    const { bytesWritten } = await writev(this.hostFd, bufs, position);
    return bytesWritten;
  }

  async stat() {
    return getNodeStats(this.hostFd, fstat);
  }

  datasync() {
    return fdatasync(this.hostFd);
  }

  sync() {
    return fsync(this.hostFd);
  }

  setSize(size: number) {
    return fruncate(this.hostFd, size);
  }

  setTimes(
    flags: SetTimeFlags,
    newAccessTime: timestamp_t,
    newModTime: timestamp_t
  ) {
    return setTimes(
      this.hostFd,
      fstat,
      flags,
      newAccessTime,
      newModTime,
      futimes
    );
  }

  async [Symbol.asyncDispose]() {
    // Don't close real stdin/stdout/stderr, as they might be still needed by the parent process.
    if (this.hostFd >= 3) {
      await close(this.hostFd);
    }
  }
}

type DirentInfo = Omit<dirent_t, 'next' | 'nameLen'> & { name: string };

// Lazy iterable that caches previous runs and can be restarted from arbitrary position.
// This is useful for reading directories in WASI, where the caller can pass an arbitrary
// index to start from. No need to reread metadata for items we've already seen.
function cachingIterable<T>(iter: AsyncIterable<T>): AsyncIterable<T> {
  let cache: T[] = [];

  async function* impl() {
    for (let item of cache) {
      yield item;
    }

    for await (let item of iter) {
      cache.push(item);
      yield item;
    }
  }

  return {
    [Symbol.asyncIterator]() {
      let implIter = impl();
      // We don't want `return()` to propagate to `iter` and stop it altogether
      // as we want to reuse it in future calls. Override it.
      implIter.return = async value => ({ done: true, value: await value });
      return implIter;
    }
  };
}

export class OpenDirectory extends OpenFile {
  protected constructor(
    private readonly _hostPath: ResolvedPath,
    hostFd: number,
    rights: Rights,
    public rightsInheriting: Rights
  ) {
    super(hostFd, FdFlags.None, rights);
  }

  joinPath(...components: string[]): ResolvedPath {
    // Note: this is a simple join, not a full path resolution.
    // We assume that components are already sanitized and don't contain any path traversal.
    return [this._hostPath, ...components].join('/') as ResolvedPath;
  }

  static async openDir(
    hostPath: ResolvedPath,
    rights: Rights,
    rightsInheriting: Rights
  ) {
    let flag = fsc.O_DIRECTORY;
    if (flag === undefined) {
      // If the O_DIRECTORY flag is not supported on this OS (like Windows), we need to check if it's actually a directory.
      if (!(await lstat(hostPath)).isDirectory()) {
        throw new SystemError(E.NOTDIR);
      }
      flag = 0; // No special flags needed.
    }
    return new OpenDirectory(
      hostPath,
      await open(hostPath, flag),
      rights,
      rightsInheriting
    );
  }

  set position(_value: number) {
    throw new SystemError(E.NOTCAPABLE);
  }

  private _entries?: AsyncIterable<DirentInfo>;

  private async *_readDirents(): AsyncIterable<DirentInfo> {
    yield {
      name: '.',
      type: FileType.Directory,
      ino: this.rights & Rights.FdFilestatGet ? (await this.stat()).ino : 0n
    };
    yield {
      name: '..',
      type: FileType.Directory,
      // We don't have rights to invoke sysops on the parent directory
      // by definition, so yield it manually with `ino: 0`.
      ino: 0n
    };
    const canStat = this.rights & Rights.PathFilestatGet;
    for (const name of await readdir(this._hostPath)) {
      if (!canStat) {
        // We don't have rights to stat, so only report the name.
        yield {
          name,
          type: FileType.Unknown,
          ino: 0n
        };
      } else {
        let stats = await lstat(this.joinPath(name), {
          bigint: true
        });
        yield {
          name,
          type: getFileType(stats),
          ino: stats.ino
        };
      }
    }
  }

  async *getEntries(start = 0) {
    // If we are starting from the beginning, refresh the entries as the directory might have changed.
    // Otherwise, continue from the same snapshot.
    if (start === 0 || !this._entries) {
      this._entries = cachingIterable(this._readDirents());
    }
    for await (const item of this._entries) {
      if (start-- > 0) {
        continue;
      }
      yield item;
    }
  }
}

export class PreopenDirectory extends OpenDirectory {
  constructor(
    public readonly wasiPath: string,
    hostPath: ResolvedPath,
    hostFd: number
  ) {
    super(hostPath, hostFd, Rights.All, Rights.All);
  }
}

function dumpRights(title: string, rights: Rights) {
  console.group(title);
  for (let i = 0; i <= 29; i++) {
    if (rights & (1 << i)) {
      console.log(`- ${Rights[1 << i]}`);
    }
  }
  console.groupEnd();
}

export class OpenFiles implements AsyncDisposable {
  private _files = new Map<fd_t, OpenFile | OpenDirectory>();
  private _nextFd = 0 as fd_t;

  constructor() {
    this._add(new OpenFile(process.stdin.fd, FdFlags.None, ~Rights.AllPath));
    this._add(new OpenFile(process.stdout.fd, FdFlags.None, ~Rights.AllPath));
    this._add(new OpenFile(process.stderr.fd, FdFlags.None, ~Rights.AllPath));
  }

  private _add(handle: OpenFile | OpenDirectory) {
    this._files.set(this._nextFd, handle);
    return this._nextFd++ as fd_t;
  }

  public async addPreOpen(wasiPath: string, hostPath: string) {
    let resolvedPath = (await realpath(hostPath)) as ResolvedPath;

    this._add(
      new PreopenDirectory(
        wasiPath,
        resolvedPath,
        await open(resolvedPath, fsc.O_DIRECTORY)
      )
    );
  }

  createDir(path: ResolvedPath) {
    return mkdir(path);
  }

  async openFile(
    path: ResolvedPath,
    openFlags: OpenFlags,
    fdFlags: FdFlags,
    rights: Rights
  ) {
    return this._add(await OpenFile.openFile(path, openFlags, fdFlags, rights));
  }

  async openDir(path: ResolvedPath, rights: Rights, rightsInheriting: Rights) {
    return this._add(
      await OpenDirectory.openDir(path, rights, rightsInheriting)
    );
  }

  get(fd: fd_t, neededRights: Rights) {
    const file = this._files.get(fd);
    if (!file) {
      throw new SystemError(E.BADF);
    }
    file.checkRights(neededRights);
    return file;
  }

  getPreOpen(fd: fd_t): PreopenDirectory {
    let file = this._files.get(fd);
    if (file instanceof PreopenDirectory) {
      return file;
    } else {
      throw new NoPreopen();
    }
  }

  getFile(fd: fd_t, neededRights: Rights): OpenFile {
    let openFile = this.get(fd, neededRights);
    if (openFile instanceof OpenFile) {
      return openFile;
    } else {
      throw new SystemError(E.ISDIR);
    }
  }

  rmFile(path: ResolvedPath) {
    return unlink(path);
  }

  getDir(fd: fd_t, neededRights: Rights): OpenDirectory {
    let openFile = this.get(fd, neededRights);
    if (openFile instanceof OpenDirectory) {
      return openFile;
    } else {
      throw new SystemError(E.NOTDIR);
    }
  }

  rmDir(path: ResolvedPath) {
    return rmdir(path);
  }

  async stat(path: ResolvedPath) {
    return getNodeStats(path, lstat);
  }

  setTimes(
    path: ResolvedPath,
    flags: SetTimeFlags,
    accessTimeNs: timestamp_t,
    modTimeNs: timestamp_t
  ) {
    return setTimes(path, lstat, flags, accessTimeNs, modTimeNs, lutimes);
  }

  link(src: ResolvedPath, dst: ResolvedPath) {
    return link(src, dst);
  }

  symLink(src: string, dst: ResolvedPath) {
    return symlink(src, dst);
  }

  readLink(path: ResolvedPath) {
    return readlink(path);
  }

  rename(oldPath: ResolvedPath, newPath: ResolvedPath) {
    return rename(oldPath, newPath);
  }

  private _take(fd: fd_t) {
    let handle = this.get(fd, Rights.None);
    this._files.delete(fd);
    return handle;
  }

  async renumber(from: fd_t, to: fd_t) {
    await this.close(to);
    this._files.set(to, this._take(from));
  }

  close(fd: fd_t) {
    return (this._take(fd) as Partial<AsyncDisposable>)[
      Symbol.asyncDispose
    ]?.();
  }

  async [Symbol.asyncDispose]() {
    await Promise.all(
      Array.from(this._files.values(), file => file[Symbol.asyncDispose]())
    );
  }
}

async function getNodeStats<T>(
  file: T,
  stat: (file: T, opts: { bigint: true }) => Promise<BigIntStats>
): Promise<filestat_t> {
  const stats = await stat(file, { bigint: true });

  return {
    dev: stats.dev,
    ino: stats.ino,
    filetype: getFileType(stats),
    nlink: stats.nlink,
    size: stats.size,
    accessTimeNs: stats.atimeNs as timestamp_t,
    modTimeNs: stats.mtimeNs as timestamp_t,
    changeTimeNs: stats.ctimeNs as timestamp_t
  };
}

export function getFileType(stats: BigIntStats): FileType {
  const kind = Number(stats.mode) & fsc.S_IFMT;

  switch (kind) {
    case fsc.S_IFREG:
      return FileType.RegularFile;
    case fsc.S_IFDIR:
      return FileType.Directory;
    case fsc.S_IFCHR:
      return FileType.CharacterDevice;
    case fsc.S_IFLNK:
      return FileType.SymbolicLink;
    case fsc.S_IFBLK:
      return FileType.BlockDevice;
    case fsc.S_IFIFO:
      return FileType.SocketDatagram; // FIFO is treated as a socket datagram.
    case fsc.S_IFSOCK:
      return FileType.SocketStream; // Socket is treated as a stream.
    default:
      console.warn(`Unsupported file type: 0x${kind.toString(16)}`);
      return FileType.Unknown;
  }
}
