import type { VoxCpmEmscriptenModule } from './module';

export type VoxCpmStorageBackend = 'opfs' | 'idbfs' | 'memfs';

export interface VoxCpmStoredEntry {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  size: number;
  mtimeMs: number | null;
}

export interface VoxCpmPersistentFsInfo {
  backend: VoxCpmStorageBackend;
  root: string;
}

export class VoxCpmStorage {
  private readonly module: VoxCpmEmscriptenModule;
  private readonly root: string;
  private mounted = false;
  private backend: VoxCpmStorageBackend | null = null;

  constructor(module: VoxCpmEmscriptenModule, root = '/persist') {
    this.module = module;
    this.root = root;
  }

  getRoot(): string {
    return this.root;
  }

  getBackend(): VoxCpmStorageBackend | null {
    return this.backend;
  }

  initPersistentFs(): VoxCpmPersistentFsInfo {
    if (this.mounted && this.backend) {
      return {
        backend: this.backend,
        root: this.root,
      };
    }

    this.ensureDir(this.root);

    if (this.module.OPFS) {
      this.module.FS.mount(this.module.OPFS, {}, this.root);
      this.backend = 'opfs';
    } else if (this.module.FS.filesystems?.IDBFS) {
      this.module.FS.mount(this.module.FS.filesystems.IDBFS, {}, this.root);
      this.backend = 'idbfs';
    } else if (this.module.MEMFS) {
      this.module.FS.mount(this.module.MEMFS, {}, this.root);
      this.backend = 'memfs';
    } else {
      throw new Error('Persistent filesystem backend is not available');
    }

    this.mounted = true;
    this.ensureDir(`${this.root}/models`);
    this.ensureDir(`${this.root}/audio`);
    this.ensureDir(`${this.root}/downloads`);

    return {
      backend: this.backend,
      root: this.root,
    };
  }

  ensureDir(path: string): void {
    try {
      if (this.module.FS.mkdirTree) {
        this.module.FS.mkdirTree(path);
        return;
      }
      this.module.FS.mkdir(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('File exists')) {
        throw error;
      }
    }
  }

  exists(path: string): boolean {
    if (this.module.FS.analyzePath) {
      return this.module.FS.analyzePath(path).exists;
    }
    try {
      this.module.FS.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  readBinaryFile(path: string): Uint8Array {
    const result = this.module.FS.readFile(path, { encoding: 'binary' });
    return typeof result === 'string' ? new TextEncoder().encode(result) : result;
  }

  writeBinaryFile(path: string, data: Uint8Array): void {
    this.ensureDir(path.slice(0, path.lastIndexOf('/')) || '/');
    this.module.FS.writeFile(path, data);
  }

  deleteFile(path: string): void {
    this.module.FS.unlink(path);
  }

  renameFile(oldPath: string, newPath: string): void {
    this.module.FS.rename(oldPath, newPath);
  }

  truncateFile(path: string, length = 0): void {
    if (this.module.FS.truncate) {
      this.module.FS.truncate(path, length);
      return;
    }
    if (length !== 0) {
      throw new Error('truncate is not supported in this build');
    }
    this.module.FS.writeFile(path, new Uint8Array(0));
  }

  openFile(path: string, flags: string | number, mode = 0o666): { fd: number } {
    return this.module.FS.open(path, flags, mode);
  }

  writeChunk(
    stream: { fd: number },
    chunk: Uint8Array,
    position?: number,
  ): number {
    return this.module.FS.write(stream, chunk, 0, chunk.length, position);
  }

  closeFile(stream: { fd: number }): void {
    this.module.FS.close(stream);
  }

  statFile(path: string): VoxCpmStoredEntry {
    const stats = this.module.FS.stat(path);
    return {
      path,
      name: path.split('/').pop() ?? path,
      kind: (stats.mode & 0o170000) === 0o040000 ? 'dir' : 'file',
      size: Number(stats.size ?? 0),
      mtimeMs: stats.mtime !== undefined ? Number(stats.mtime) : null,
    };
  }

  listFiles(path: string): VoxCpmStoredEntry[] {
    return this.module.FS.readdir(path)
      .filter((name) => name !== '.' && name !== '..')
      .map((name) => this.statFile(`${path}/${name}`))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  listStoredModels(): VoxCpmStoredEntry[] {
    return this.listFiles(`${this.root}/models`).filter((entry) => entry.name.endsWith('.gguf'));
  }

  listStoredAudios(): VoxCpmStoredEntry[] {
    return this.listFiles(`${this.root}/audio`).filter((entry) => entry.name.endsWith('.wav'));
  }

  listDownloads(): VoxCpmStoredEntry[] {
    return this.listFiles(`${this.root}/downloads`);
  }
}
