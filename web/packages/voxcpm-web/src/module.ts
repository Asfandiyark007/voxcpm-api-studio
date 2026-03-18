import type { VoxCpmModuleInitOptions } from './types';

export interface VoxCpmEmscriptenModule {
  FS: {
    createPath(parent: string, path: string, canRead: boolean, canWrite: boolean): string;
    mkdir(path: string): void;
    mkdirTree?(path: string): void;
    readFile(path: string, opts?: { encoding?: 'utf8' | 'binary' }): string | Uint8Array;
    readdir(path: string): string[];
    stat(path: string): {
      mode: number;
      size: number;
      mtime?: number;
      ctime?: number;
      atime?: number;
    };
    analyzePath?(path: string): { exists: boolean };
    unlink(path: string): void;
    rename(oldPath: string, newPath: string): void;
    open(path: string, flags: string | number, mode?: number): { fd: number };
    close(stream: { fd: number }): void;
    write(
      stream: { fd: number },
      buffer: Uint8Array,
      offset: number,
      length: number,
      position?: number,
    ): number;
    llseek?(stream: { fd: number }, offset: number, whence: number): number;
    truncate?(path: string, length: number): void;
    mount(
      type: { createBackend(opts?: Record<string, unknown>): unknown },
      opts: Record<string, unknown>,
      path: string,
    ): void;
    unmount(path: string): void;
    writeFile(path: string, data: Uint8Array | string): void;
    filesystems?: {
      MEMFS?: unknown;
      WORKERFS?: unknown;
      IDBFS?: { createBackend(opts?: Record<string, unknown>): unknown };
    };
  };
  OPFS?: { createBackend(opts?: Record<string, unknown>): unknown };
  MEMFS?: { createBackend(opts?: Record<string, unknown>): unknown };
  wasmMemory: WebAssembly.Memory;
  _malloc(size: number): number;
  _free(ptr: number): void;
  lengthBytesUTF8(value: string): number;
  stringToUTF8(value: string, ptr: number, size: number): void;
  UTF8ToString(ptr: number): string;
  _voxcpm_create_engine(): number;
  _voxcpm_destroy_engine(handle: number): void;
  _voxcpm_load_model(handle: number, modelPathPtr: number, threads: number): number;
  _voxcpm_infer(
    handle: number,
    textPtr: number,
    promptTextPtr: number,
    promptAudioPtr: number,
    promptAudioLen: number,
    promptAudioSampleRate: number,
    inferenceTimesteps: number,
    cfgValue: number,
    seed: number,
    maxDecodeSteps: number,
  ): number;
  _voxcpm_get_audio_ptr(handle: number): number;
  _voxcpm_get_audio_len(handle: number): number;
  _voxcpm_get_audio_sample_rate(handle: number): number;
  _voxcpm_get_required_prompt_sample_rate(handle: number): number;
  _voxcpm_get_last_error(handle: number): number;
}

export async function initVoxCpmModule(
  options: VoxCpmModuleInitOptions = {},
): Promise<VoxCpmEmscriptenModule> {
  const moduleScriptUrl =
    options.moduleScriptUrl ??
    new URL('./wasm/generated/voxcpm_wasm.js', import.meta.url).toString();
  const wasmUrl =
    options.wasmUrl ?? new URL('./wasm/generated/voxcpm_wasm.wasm', import.meta.url).toString();

  const importModuleScript = new Function(
    'u',
    'return import(/* webpackIgnore: true */ u)',
  ) as (url: string) => Promise<{
    default: (moduleOverrides?: Record<string, unknown>) => Promise<unknown>;
  }>;

  const moduleFactoryModule = await importModuleScript(moduleScriptUrl);

  const module = await moduleFactoryModule.default({
    locateFile(file: string) {
      if (file.endsWith('.wasm')) {
        return wasmUrl;
      }
      return new URL(`./${file}`, moduleScriptUrl).toString();
    },
    mainScriptUrlOrBlob: moduleScriptUrl,
    pthreadPoolSize: options.pthreadPoolSize ?? 4,
  });

  if ((module as { pthreadPoolReady?: Promise<unknown> }).pthreadPoolReady) {
    await (module as { pthreadPoolReady: Promise<unknown> }).pthreadPoolReady;
  }

  return module as VoxCpmEmscriptenModule;
}
