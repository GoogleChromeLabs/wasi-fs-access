// Modified from https://gist.githubusercontent.com/screeny05/b1b7cbeb81479ece36dae21a9ee17d30/raw/8aa25f95b4dc5715cf6622664a12e51b6f10574c/index.ts

declare enum ChooseFileSystemEntriesType {
    'open-file',
    'save-file',
    'open-directory'
}

interface ChooseFileSystemEntriesOptionsAccepts {
    description?: string;
    mimeTypes?: string;
    extensions?: string;
}

interface ChooseFileSystemEntriesOptions {
    type?: ChooseFileSystemEntriesType;
    multiple?: boolean;
    accepts?: ChooseFileSystemEntriesOptionsAccepts[];
    excludeAcceptAllOption?: boolean;
}

interface FileSystemHandlePermissionDescriptor {
    writable?: boolean;
}

interface FileSystemCreateWriterOptions {
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

declare enum SystemDirectoryType {
    'sandbox'
}

interface GetSystemDirectoryOptions {
    type: SystemDirectoryType;
}

interface FileSystemWriter {
    write(position: number, data: BufferSource | Blob | string): Promise<void>;
    truncate(size: number): Promise<void>;
    close(): Promise<void>;
}

interface FileSystemWriterConstructor {
    new(): FileSystemWriter;
}

interface FileSystemHandle {
    isFile: Readonly<boolean>;
    isDirectory: Readonly<boolean>;
    name: Readonly<string>;
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface FileSystemHandleConstructor {
    new(): FileSystemHandle;
}

interface FileSystemFileHandle extends FileSystemHandle {
    getFile(): Promise<File>;
    createWriter(options?: FileSystemCreateWriterOptions): Promise<FileSystemWriter>;
}

interface FileSystemFileHandleConstructor {
    new(): FileSystemFileHandle;
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
    getFile(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle>;
    getDirectory(name: string, options?: FileSystemGetDirectoryOptions): Promise<FileSystemDirectoryHandle>;
    getEntries(): AsyncIterable<FileSystemFileHandle | FileSystemDirectoryHandle>;
    removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void>;
}

interface FileSystemDirectoryHandleConstructor {
    new(): FileSystemDirectoryHandle;
    getSystemDirectory(options: GetSystemDirectoryOptions): Promise<FileSystemDirectoryHandle>;
}

declare function chooseFileSystemEntries(options?: ChooseFileSystemEntriesOptions): Promise<FileSystemHandle | FileSystemHandle[]>;
declare const FileSystemHandle: FileSystemHandleConstructor;
declare const FileSystemFileHandle: FileSystemFileHandleConstructor;
declare const FileSystemDirectoryHandle: FileSystemDirectoryHandleConstructor;
declare const FileSystemWriter: FileSystemWriterConstructor;
