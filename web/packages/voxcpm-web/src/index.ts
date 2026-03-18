import { initVoxCpmModule, type VoxCpmEmscriptenModule } from './module';
import {
  VoxCpmStorage,
  type VoxCpmPersistentFsInfo,
  type VoxCpmStoredEntry,
  type VoxCpmStorageBackend,
} from './storage';
import type {
  VoxCpmModuleInitOptions,
  VoxCpmSynthesisOptions,
  VoxCpmSynthesisResult,
} from './types';

function ensureDir(module: VoxCpmEmscriptenModule, path: string): void {
  try {
    if (module.FS.mkdirTree) {
      module.FS.mkdirTree(path);
      return;
    }
    module.FS.mkdir(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('File exists')) {
      throw error;
    }
  }
}

function withCString<T>(
  module: VoxCpmEmscriptenModule,
  value: string,
  fn: (ptr: number) => T,
): T {
  const size = module.lengthBytesUTF8(value) + 1;
  const ptr = module._malloc(size);
  try {
    module.stringToUTF8(value, ptr, size);
    return fn(ptr);
  } finally {
    module._free(ptr);
  }
}

function readLastError(module: VoxCpmEmscriptenModule, handle: number): string {
  const ptr = module._voxcpm_get_last_error(handle);
  return ptr ? module.UTF8ToString(ptr) : 'Unknown VoxCPM error';
}

function getHeapF32(module: VoxCpmEmscriptenModule): Float32Array {
  return new Float32Array(module.wasmMemory.buffer);
}

export class VoxCpmSession {
  private readonly module: VoxCpmEmscriptenModule;
  private readonly handle: number;
  private mountedModelDir: string | null = null;

  constructor(module: VoxCpmEmscriptenModule) {
    this.module = module;
    this.handle = module._voxcpm_create_engine();
    if (!this.handle) {
      throw new Error('Failed to create VoxCPM engine');
    }
  }

  getRequiredPromptSampleRate(): number {
    return this.module._voxcpm_get_required_prompt_sample_rate(this.handle);
  }

  async writeModelFile(file: File, mountPath = '/models'): Promise<string> {
    ensureDir(this.module, mountPath);
    const modelPath = `${mountPath}/${file.name}`;
    const data = new Uint8Array(await file.arrayBuffer());
    this.module.FS.writeFile(modelPath, data);
    this.mountedModelDir = mountPath;
    return modelPath;
  }

  loadModel(modelPath: string, threads = 1): void {
    const ok = withCString(this.module, modelPath, (modelPathPtr) =>
      this.module._voxcpm_load_model(this.handle, modelPathPtr, threads),
    );
    if (!ok) {
      throw new Error(readLastError(this.module, this.handle));
    }
  }

  async loadModelFile(file: File, threads = 1, mountPath = '/models'): Promise<string> {
    const modelPath = await this.writeModelFile(file, mountPath);
    this.loadModel(modelPath, threads);
    return modelPath;
  }

  synthesize(options: VoxCpmSynthesisOptions): VoxCpmSynthesisResult {
    const {
      text,
      promptText = '',
      promptAudio,
      promptAudioSampleRate = 0,
      inferenceTimesteps = 10,
      cfgValue = 2,
      seed = 1337,
      maxDecodeSteps = 0,
    } = options;

    if (!text.trim()) {
      throw new Error('Text must not be empty');
    }
    if (promptAudio && promptAudio.length > 0 && promptAudioSampleRate <= 0) {
      throw new Error('Prompt audio sample rate must be provided');
    }

    let promptAudioPtr = 0;
    if (promptAudio && promptAudio.length > 0) {
      promptAudioPtr = this.module._malloc(promptAudio.length * Float32Array.BYTES_PER_ELEMENT);
      getHeapF32(this.module).set(
        promptAudio,
        promptAudioPtr / Float32Array.BYTES_PER_ELEMENT,
      );
    }

    try {
      const ok = withCString(this.module, text, (textPtr) =>
        withCString(this.module, promptText, (promptTextPtr) =>
          this.module._voxcpm_infer(
            this.handle,
            textPtr,
            promptTextPtr,
            promptAudioPtr,
            promptAudio?.length ?? 0,
            promptAudioSampleRate,
            inferenceTimesteps,
            cfgValue,
            seed,
            maxDecodeSteps,
          ),
        ),
      );

      if (!ok) {
        throw new Error(readLastError(this.module, this.handle));
      }

      const audioPtr = this.module._voxcpm_get_audio_ptr(this.handle);
      const audioLen = this.module._voxcpm_get_audio_len(this.handle);
      const sampleRate = this.module._voxcpm_get_audio_sample_rate(this.handle);
      const audio = getHeapF32(this.module).slice(
        audioPtr / Float32Array.BYTES_PER_ELEMENT,
        audioPtr / Float32Array.BYTES_PER_ELEMENT + audioLen,
      );

      return {
        audio: new Float32Array(audio),
        sampleRate,
      };
    } finally {
      if (promptAudioPtr) {
        this.module._free(promptAudioPtr);
      }
    }
  }

  destroy(): void {
    this.module._voxcpm_destroy_engine(this.handle);
  }
}

export { initVoxCpmModule };
export { VoxCpmStorage };
export type {
  VoxCpmModuleInitOptions,
  VoxCpmSynthesisOptions,
  VoxCpmSynthesisResult,
} from './types';
export type { VoxCpmPersistentFsInfo, VoxCpmStoredEntry, VoxCpmStorageBackend };
