export interface VoxCpmSynthesisOptions {
  text: string;
  promptText?: string;
  promptAudio?: Float32Array;
  promptAudioSampleRate?: number;
  inferenceTimesteps?: number;
  cfgValue?: number;
  seed?: number;
  maxDecodeSteps?: number;
}

export interface VoxCpmSynthesisResult {
  audio: Float32Array;
  sampleRate: number;
}

export interface VoxCpmModuleInitOptions {
  wasmUrl?: string;
  moduleScriptUrl?: string;
  pthreadPoolSize?: number;
}
