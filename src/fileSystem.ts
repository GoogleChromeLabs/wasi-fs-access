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

import type { BigIntStats, Dirent } from 'node:fs';
import * as fs from 'node:fs';
import { mkdir, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
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
  timestamp_t
} from './bindings.js';
import { resolve as resolvePath, join as joinPath } from 'node:path/posix';
import { promisify } from 'node:util';

// Note: not using fs/promises because it doesn't allow constructing file handles from raw fd, and we need some file ops for stdin/stdout/stderr.
const open = promisify(fs.open);
const readv = promisify(fs.readv);
const writev = promisify(fs.writev);
const fstat = promisify(fs.fstat);
const fdatasync = promisify(fs.fdatasync);
const fsync = promisify(fs.fsync);
const fruncate = promisify(fs.ftruncate);
const utimes = promisify(fs.futimes);
const close = promisify(fs.close);

const fsc = fs.constants;

export class OpenFile implements AsyncDisposable {
  constructor(
    private readonly hostFd: number,
    public readonly isAppend: boolean
  ) {}

  static async openFile(
    hostPath: string,
    openFlags: OpenFlags,
    fdFlags: FdFlags,
    rights: Rights
  ) {
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

    return new OpenFile(
      await open(hostPath, nodeFlags),
      // Note: do not use O_APPEND, as it opens us to kernel differences and shenanigans.
      // We already need to do our own position tracking anyway (since Node.js doesn't expose it), so we can handle appending ourselves.
      !!(fdFlags & FdFlags.Append)
    );
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
    return convertNodeStats(await fstat(this.hostFd, { bigint: true }));
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

  setTimes(accessTimeNs: bigint, modTimeNs: bigint) {
    // Node.js doesn't support setting change time, so we ignore it.
    return utimes(
      this.hostFd,
      Number(accessTimeNs) / 1e6,
      Number(modTimeNs) / 1e6
    );
  }

  async [Symbol.asyncDispose]() {
    // Don't close real stdin/stdout/stderr, as they might be still needed by the parent process.
    if (this.hostFd >= 3) {
      await close(this.hostFd);
    }
  }
}

export class OpenDirectory extends OpenFile {
  constructor(private readonly _hostPath: string, hostFd: number) {
    super(hostFd, false);
    // TODO: add handling for inheriting rights.
  }

  static async openDir(hostPath: string) {
    return new OpenDirectory(hostPath, await open(hostPath, fsc.O_DIRECTORY));
  }

  set position(_value: number) {
    throw new SystemError(E.NOTCAPABLE);
  }

  private _entries?: Pick<Dirent, 'name' | 'isFile' | 'isDirectory'>[];

  async getEntries(start = 0) {
    this._entries ??= [
      // Add fake entries for '.' and '..' to match expected WASI behaviour.
      {
        name: '.',
        isFile: () => false,
        isDirectory: () => true
      },
      {
        name: '..',
        isFile: () => false,
        isDirectory: () => true
      },
      ...(await readdir(this._hostPath, { withFileTypes: true }))
    ];
    return this._entries.slice(start);
  }

  resolve(path: string) {
    path = joinPath(this._hostPath, path);
    if (path !== this._hostPath && !path.startsWith(`${this._hostPath}/`)) {
      // Prevent access outside the given directory descriptor.
      throw new SystemError(E.NOTCAPABLE);
    }
    return path;
  }
}

export class PreopenDirectory extends OpenDirectory {
  constructor(
    public readonly wasiPath: string,
    ...args: ConstructorParameters<typeof OpenDirectory>
  ) {
    super(...args);
  }
}

export class OpenFiles implements AsyncDisposable {
  private _files = new Map<fd_t, OpenFile | OpenDirectory>();
  private _nextFd = 0 as fd_t;

  constructor() {
    this._add(new OpenFile(process.stdin.fd, false));
    this._add(new OpenFile(process.stdout.fd, false));
    this._add(new OpenFile(process.stderr.fd, false));
  }

  private _add(handle: OpenFile | OpenDirectory) {
    this._files.set(this._nextFd, handle);
    return this._nextFd++ as fd_t;
  }

  public async addPreOpen(wasiPath: string, hostPath: string) {
    // We'll be judging "did this thing resolve outside the preopen directory" by checking if the resolved path starts with the preopen path.
    // In order to do that, we need to store a fully resolved path.
    hostPath = resolvePath(hostPath);

    this._add(
      new PreopenDirectory(
        wasiPath,
        hostPath,
        await open(hostPath, fsc.O_DIRECTORY)
      )
    );
  }

  createDir(path: string) {
    return mkdir(path);
  }

  async open(
    path: string,
    openFlags: OpenFlags,
    fdFlags: FdFlags,
    rights: Rights,
    rightsInheriting: Rights
  ) {
    if (openFlags & OpenFlags.Directory) {
      return this._add(await OpenDirectory.openDir(path));
    } else {
      return this._add(
        await OpenFile.openFile(path, openFlags, fdFlags, rights)
      );
    }
  }

  get(fd: fd_t) {
    const file = this._files.get(fd);
    if (!file) {
      throw new SystemError(E.BADF);
    }
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

  getFile(fd: fd_t): OpenFile {
    let openFile = this.get(fd);
    if (openFile instanceof OpenFile) {
      return openFile;
    } else {
      throw new SystemError(E.ISDIR);
    }
  }

  rmFile(path: string) {
    return unlink(path);
  }

  getDir(fd: fd_t): OpenDirectory {
    let openFile = this.get(fd);
    if (openFile instanceof OpenDirectory) {
      return openFile;
    } else {
      throw new SystemError(E.NOTDIR);
    }
  }

  rmDir(path: string) {
    return rmdir(path);
  }

  async stat(path: string) {
    return convertNodeStats(await stat(path, { bigint: true }));
  }

  rename(oldPath: string, newPath: string) {
    return rename(oldPath, newPath);
  }

  private _take(fd: fd_t) {
    let handle = this.get(fd);
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

function convertNodeStats(stats: BigIntStats): filestat_t {
  return {
    dev: stats.dev,
    ino: stats.ino,
    filetype: getFileType(stats),
    nlink: stats.nlink,
    size: stats.size,
    accessTime: timestamp_t.fromRaw(stats.atimeNs as timestamp_t),
    modTime: timestamp_t.fromRaw(stats.mtimeNs as timestamp_t),
    changeTime: timestamp_t.fromRaw(stats.ctimeNs as timestamp_t)
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
