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

import { fd_t, OpenFlags, SystemError, E } from './bindings.js';

export type Handle = FileSystemFileHandle | FileSystemDirectoryHandle;

class OpenDirectory {
  constructor(
    public readonly path: string,
    private readonly _handle: FileSystemDirectoryHandle
  ) {}

  isFile!: false;

  asFile(): never {
    throw new SystemError(E.ISDIR);
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
          throw new SystemError(E.NOTCAPABLE);
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
    mode: FileOrDir.File,
    openFlags?: OpenFlags
  ): Promise<FileSystemFileHandle>;
  getFileOrDir(
    path: string,
    mode: FileOrDir.Dir,
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
          throw new SystemError(E.EXIST);
        }
        if (openFlags & OpenFlags.Truncate) {
          throw new SystemError(E.ISDIR);
        }
        return parent;
      } else {
        throw new SystemError(E.ISDIR);
      }
    }
    let name = maybeName;
    async function openWithCreate(create: boolean) {
      if (mode & FileOrDir.File) {
        try {
          return await parent.getFile(name, { create });
        } catch (err) {
          if (err.name === 'TypeMismatchError') {
            if (!(mode & FileOrDir.Dir)) {
              console.warn(err);
              throw new SystemError(E.ISDIR);
            }
          } else {
            throw err;
          }
        }
      }
      try {
        return await parent.getDirectory(name, { create });
      } catch (err) {
        if (err.name === 'TypeMismatchError') {
          console.warn(err);
          throw new SystemError(E.NOTDIR);
        } else {
          throw err;
        }
      }
    }
    if (openFlags & OpenFlags.Directory) {
      if (mode & FileOrDir.Dir) {
        mode = FileOrDir.Dir;
      } else {
        throw new TypeError(
          `Open flags ${openFlags} require a directory but mode ${mode} doesn't allow it.`
        );
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
          throw new SystemError(E.EXIST);
        }
      }
      handle = await openWithCreate(true);
    } else {
      handle = await openWithCreate(false);
    }
    if (openFlags & OpenFlags.Truncate) {
      if (handle.isDirectory) {
        throw new SystemError(E.ISDIR);
      }
      let writable = await handle.createWritable({ keepExistingData: false });
      await writable.close();
    }
    return handle;
  }

  async delete(path: string) {
    let { parent, name } = await this._resolve(path);
    if (!name) {
      throw new SystemError(E.ACCES);
    }
    await parent.removeEntry(name);
  }

  close() {}
}

OpenDirectory.prototype.isFile = false;

class OpenFile {
  constructor(
    public readonly path: string,
    private readonly _handle: FileSystemFileHandle
  ) {}

  isFile!: true;

  public position = 0;
  private _file: File | undefined = undefined;
  private _writer: FileSystemWritableFileStream | undefined = undefined;

  async getFile() {
    // TODO: do we really have to?
    await this.flush();
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
    await writer.write({ type: 'write', position: this.position, data });
    this.position += data.length;
  }

  async flush() {
    if (!this._writer) return;
    await this._writer.close();
    this._writer = undefined;
    this._file = undefined;
  }

  asFile() {
    return this;
  }

  asDir(): never {
    throw new SystemError(E.NOTDIR);
  }

  close() {
    return this.flush();
  }
}

OpenFile.prototype.isFile = true;

export const enum FileOrDir {
  File = 1, // 1 << 0
  Dir = 2, // 1 << 1
  Any = 3 // File | Dir
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
      throw new SystemError(E.BADF);
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
      throw new SystemError(E.BADF);
    }
    return openFile;
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

  async close(fd: fd_t) {
    await this._take(fd).close();
  }

  // Translation of the algorithm from __wasilibc_find_relpath.
  findRelPath(path: string) {
    /// Are the `prefix_len` bytes pointed to by `prefix` a prefix of `path`?
    function prefixMatches(prefix: string, path: string) {
      // Allow an empty string as a prefix of any relative path.
      if (path[0] != '/' && !prefix) {
        return true;
      }

      // Check whether any bytes of the prefix differ.
      if (!path.startsWith(prefix)) {
        return false;
      }

      // Ignore trailing slashes in directory names.
      let i = prefix.length;
      while (i > 0 && prefix[i - 1] == '/') {
        --i;
      }

      // Match only complete path components.
      let last = path[i];
      return last === '/' || last === '\0';
    }

    // Search through the preopens table. Iterate in reverse so that more
    // recently added preopens take precedence over less recently addded ones.
    let matchLen = 0;
    let foundPre;
    for (let i = this._firstNonPreopenFd - 1; i >= FIRST_PREOPEN_FD; --i) {
      let pre = this.get(i as fd_t) as OpenDirectory;
      let prefix = pre.path;

      if (path !== '.' && !path.startsWith('./')) {
        // We're matching a relative path that doesn't start with "./" and
        // isn't ".".
        if (prefix.startsWith('./')) {
          prefix = prefix.slice(2);
        } else if (prefix === '.') {
          prefix = prefix.slice(1);
        }
      }

      // If we haven't had a match yet, or the candidate path is longer than
      // our current best match's path, and the candidate path is a prefix of
      // the requested path, take that as the new best path.
      if (
        (!foundPre || prefix.length > matchLen) &&
        prefixMatches(prefix, path)
      ) {
        foundPre = pre;
        matchLen = prefix.length;
      }
    }

    if (!foundPre) {
      throw new Error(
        `Couldn't resolve the given path via preopened directories.`
      );
    }

    // The relative path is the substring after the portion that was matched.
    let computed = path.slice(matchLen);

    // Omit leading slashes in the relative path.
    computed = computed.replace(/^\/+/, '');

    // *at syscalls don't accept empty relative paths, so use "." instead.
    computed = computed || '.';

    return {
      preOpen: foundPre,
      relativePath: computed
    };
  }
}
