interface FilePickerAcceptType {
  description: string;
  accept: Record<string, string[]>;
}

interface FilePickerOptions {
  types: FilePickerAcceptType[];
  excludeAcceptAllOption: boolean;
}

interface OpenFilePickerOptions extends FilePickerOptions {
  multiple?: boolean;
}

interface SaveFilePickerOptions extends FilePickerOptions {}

interface DirectoryPickerOptions {}

interface FileSystemHandlePermissionDescriptor {
  writable?: boolean;
}

interface FileSystemCreateWritableOptions {
  keepExistingData?: boolean;
}

interface FileSystemGetFileOptions {
  create?: boolean;
}

interface FileSystemGetDirectoryOptions {
  create?: boolean;
}

interface FileSystemRemoveOptions {
  recursive?: boolean;
}

type WriteParams =
  | { type: 'write'; position?: number; data: BufferSource | Blob | string }
  | { type: 'seek'; position: number }
  | { type: 'truncate'; size: number };

type FileSystemWriteChunkType = BufferSource | Blob | string | WriteParams;

interface FileSystemWritableFileStream extends WritableStream {
  write(data: FileSystemWriteChunkType): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
}

interface BaseFileSystemHandle {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;

  isSameEntry(other: FileSystemHandle): Promise<boolean>;
  queryPermission(
    descriptor?: FileSystemHandlePermissionDescriptor
  ): Promise<PermissionState>;
  requestPermission(
    descriptor?: FileSystemHandlePermissionDescriptor
  ): Promise<PermissionState>;
}

interface FileSystemFileHandle extends BaseFileSystemHandle {
  readonly isFile: true;
  readonly isDirectory: false;
  isSameEntry(other: FileSystemDirectoryHandle): Promise<false>;
  getFile(): Promise<File>;
  createWritable(
    options?: FileSystemCreateWritableOptions
  ): Promise<FileSystemWritableFileStream>;
}

interface FileSystemDirectoryHandle extends BaseFileSystemHandle {
  readonly isFile: false;
  readonly isDirectory: true;
  isSameEntry(other: FileSystemFileHandle): Promise<false>;
  getFile(
    name: string,
    options?: FileSystemGetFileOptions
  ): Promise<FileSystemFileHandle>;
  getDirectory(
    name: string,
    options?: FileSystemGetDirectoryOptions
  ): Promise<FileSystemDirectoryHandle>;
  removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void>;
  resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null>;
  // Note: these iterables are not yet implemented in Chrome.
  [Symbol.asyncIterator](): AsyncIterable<FileSystemHandle>;
  keys(): AsyncIterable<string>;
  values(): AsyncIterable<FileSystemHandle>;
  entries(): AsyncIterable<[string, FileSystemHandle]>;
}

type FileSystemHandle = FileSystemFileHandle | FileSystemDirectoryHandle;

declare function showOpenFilePicker(
  options?: OpenFilePickerOptions
): Promise<FileSystemFileHandle[]>;
declare function showSaveFilePicker(
  options?: SaveFilePickerOptions
): Promise<FileSystemFileHandle>;
declare function showDirectoryPicker(
  options?: DirectoryPickerOptions
): Promise<FileSystemDirectoryHandle>;
declare function getOriginPrivateDirectory(): Promise<
  FileSystemDirectoryHandle
>;

// Old methods available on stable Chrome instead of the ones above.

declare function chooseFileSystemEntries(
  options?: { type: 'open-file'; multiple?: false } & OpenFilePickerOptions
): Promise<FileSystemFileHandle>;
declare function chooseFileSystemEntries(
  options?: { type: 'open-file'; multiple: true } & OpenFilePickerOptions
): Promise<FileSystemFileHandle[]>;
declare function chooseFileSystemEntries(
  options?: { type: 'save-file' } & SaveFilePickerOptions
): Promise<FileSystemFileHandle[]>;
declare function chooseFileSystemEntries(
  options?: { type: 'open-directory' } & DirectoryPickerOptions
): Promise<FileSystemDirectoryHandle>;

interface GetSystemDirectoryOptions {
  type: 'sandbox';
}

declare const FileSystemDirectoryHandle: {
  getSystemDirectory(
    options: GetSystemDirectoryOptions
  ): Promise<FileSystemDirectoryHandle>;
};

interface FileSystemDirectoryHandle {
  getEntries(): AsyncIterable<FileSystemHandle>;
}
