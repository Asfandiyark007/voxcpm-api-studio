import {
  VoxCpmSession,
  VoxCpmStorage,
  initVoxCpmModule,
  type VoxCpmPersistentFsInfo,
  type VoxCpmStoredEntry,
} from '@voxcpm/web';

const workerScope = self as typeof self & {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void | Promise<void>) | null;
};

const isDev = typeof process !== 'undefined'
  ? process.env.NODE_ENV !== 'production'
  : true;

function log(...args: unknown[]): void {
  if (isDev) {
    console.log('[voxcpm-worker]', ...args);
  }
}

function logError(...args: unknown[]): void {
  console.error('[voxcpm-worker]', ...args);
}

function getCrossOriginIsolationError(): Error {
  return new Error(
    '当前页面没有启用 cross-origin isolation，pthread 版 WASM 不能使用 SharedArrayBuffer。请确认服务端返回了 Cross-Origin-Opener-Policy: same-origin 和 Cross-Origin-Embedder-Policy: require-corp，并重启开发服务器。',
  );
}

type RuntimeState = {
  session: VoxCpmSession;
  storage: VoxCpmStorage;
  fsInfo: VoxCpmPersistentFsInfo;
};

type WorkerRequest =
  | {
      id: number;
      type: 'load-model';
      modelFile: File;
      threads: number;
    }
  | {
      id: number;
      type: 'load-model-path';
      path: string;
      threads: number;
    }
  | {
      id: number;
      type: 'synthesize';
      text: string;
      promptText: string;
      promptAudio?: ArrayBuffer;
      promptAudioSampleRate?: number;
      inferenceTimesteps: number;
      cfgValue: number;
      seed: number;
      maxDecodeSteps: number;
    }
  | {
      id: number;
      type: 'list-storage';
    }
  | {
      id: number;
      type: 'delete-storage-entry';
      path: string;
    }
  | {
      id: number;
      type: 'read-storage-file';
      path: string;
    }
  | {
      id: number;
      type: 'save-generated-audio';
      fileName: string;
      data: ArrayBuffer;
    }
  | {
      id: number;
      type: 'download-model';
      url: string;
      fileName: string;
    };

type WorkerResponse =
  | {
      id: number;
      ok: true;
      type: 'status';
      stage: 'load-model' | 'synthesize' | 'download-model' | 'storage';
      message: string;
    }
  | {
      id: number;
      ok: true;
      type: 'download-progress';
      fileName: string;
      path: string;
      downloadedBytes: number;
      totalBytes: number | null;
      progress: number | null;
      state: 'downloading' | 'completed' | 'error';
      message: string;
    }
  | {
      id: number;
      ok: true;
      type: 'load-model';
      path: string;
      requiredPromptSampleRate: number;
      elapsedMs: number;
    }
  | {
      id: number;
      ok: true;
      type: 'synthesize';
      audio: ArrayBuffer;
      sampleRate: number;
      elapsedMs: number;
      audioDurationMs: number;
    }
  | {
      id: number;
      ok: true;
      type: 'list-storage';
      backend: VoxCpmPersistentFsInfo['backend'];
      root: string;
      models: VoxCpmStoredEntry[];
      audios: VoxCpmStoredEntry[];
      downloads: VoxCpmStoredEntry[];
    }
  | {
      id: number;
      ok: true;
      type: 'delete-storage-entry';
      path: string;
    }
  | {
      id: number;
      ok: true;
      type: 'read-storage-file';
      path: string;
      data: ArrayBuffer;
    }
  | {
      id: number;
      ok: true;
      type: 'save-generated-audio';
      entry: VoxCpmStoredEntry;
    }
  | {
      id: number;
      ok: true;
      type: 'download-model';
      entry: VoxCpmStoredEntry;
      elapsedMs: number;
      resumed: boolean;
    }
  | { id: number; ok: false; error: string };

let runtimePromise: Promise<RuntimeState> | null = null;

function getRequestStage(
  type: WorkerRequest['type'],
): 'load-model' | 'synthesize' | 'download-model' | 'storage' {
  switch (type) {
    case 'load-model':
    case 'load-model-path':
      return 'load-model';
    case 'synthesize':
      return 'synthesize';
    case 'download-model':
      return 'download-model';
    default:
      return 'storage';
  }
}

function toStandaloneArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function viewToStandaloneArrayBuffer(view: ArrayBufferView): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function postStatus(
  id: number,
  stage: 'load-model' | 'synthesize' | 'download-model' | 'storage',
  message: string,
): void {
  const response: WorkerResponse = {
    id,
    ok: true,
    type: 'status',
    stage,
    message,
  };
  workerScope.postMessage(response);
}

function postDownloadProgress(
  id: number,
  fileName: string,
  path: string,
  downloadedBytes: number,
  totalBytes: number | null,
  state: 'downloading' | 'completed' | 'error',
  message: string,
): void {
  const response: WorkerResponse = {
    id,
    ok: true,
    type: 'download-progress',
    fileName,
    path,
    downloadedBytes,
    totalBytes,
    progress: totalBytes && totalBytes > 0 ? downloadedBytes / totalBytes : null,
    state,
    message,
  };
  workerScope.postMessage(response);
}

async function getRuntime(): Promise<RuntimeState> {
  if (!runtimePromise) {
    log('crossOriginIsolated=', self.crossOriginIsolated);
    if (!self.crossOriginIsolated) {
      throw getCrossOriginIsolationError();
    }
    log('initializing wasm module');
    const promise = initVoxCpmModule({
      pthreadPoolSize:
        typeof navigator !== 'undefined' && navigator.hardwareConcurrency
          ? Math.max(2, Math.min(8, navigator.hardwareConcurrency))
          : 4,
    })
      .then((module: ConstructorParameters<typeof VoxCpmSession>[0]) => {
        log('wasm module initialized');
        const storage = new VoxCpmStorage(module);
        const fsInfo = storage.initPersistentFs();
        log('persistent fs mounted', fsInfo);
        return {
          session: new VoxCpmSession(module),
          storage,
          fsInfo,
        };
      })
      .catch((error: unknown) => {
        runtimePromise = null;
        throw error;
      });
    runtimePromise = promise;
  }
  return runtimePromise;
}

function listStorage(storage: VoxCpmStorage, fsInfo: VoxCpmPersistentFsInfo): Extract<
  WorkerResponse,
  { type: 'list-storage' }
> {
  return {
    id: 0,
    ok: true,
    type: 'list-storage',
    backend: fsInfo.backend,
    root: fsInfo.root,
    models: storage.listStoredModels(),
    audios: storage.listStoredAudios(),
    downloads: storage.listDownloads(),
  };
}

function sanitizeFileStem(input: string): string {
  const collapsed = input
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.+$/g, '');

  if (!collapsed) {
    return 'untitled';
  }

  return collapsed.slice(0, 80);
}

function ensureUniqueFilePath(storage: VoxCpmStorage, directory: string, fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  const stem = dotIndex >= 0 ? fileName.slice(0, dotIndex) : fileName;
  const extension = dotIndex >= 0 ? fileName.slice(dotIndex) : '';
  let candidate = `${directory}/${fileName}`;
  let index = 1;
  while (storage.exists(candidate)) {
    index += 1;
    candidate = `${directory}/${stem}-${index}${extension}`;
  }
  return candidate;
}

function getTotalBytes(response: Response, existingBytes: number): number | null {
  const contentRange = response.headers.get('content-range');
  if (contentRange) {
    const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(contentRange);
    if (match) {
      return Number(match[1]);
    }
  }

  const contentLength = response.headers.get('content-length');
  if (!contentLength) {
    return null;
  }

  const length = Number(contentLength);
  if (Number.isNaN(length)) {
    return null;
  }

  return response.status === 206 ? existingBytes + length : length;
}

async function handleDownloadModel(
  runtime: RuntimeState,
  request: Extract<WorkerRequest, { type: 'download-model' }>,
): Promise<Extract<WorkerResponse, { type: 'download-model' }>> {
  const { storage } = runtime;
  const startTime = performance.now();
  const finalPath = `${storage.getRoot()}/models/${request.fileName}`;
  const tempPath = `${storage.getRoot()}/downloads/${request.fileName}.part`;

  if (storage.exists(finalPath)) {
    return {
      id: request.id,
      ok: true,
      type: 'download-model',
      entry: storage.statFile(finalPath),
      elapsedMs: 0,
      resumed: false,
    };
  }

  let resumed = false;
  let existingBytes = storage.exists(tempPath) ? storage.statFile(tempPath).size : 0;
  const headers: Record<string, string> = {};
  if (existingBytes > 0) {
    headers.Range = `bytes=${existingBytes}-`;
    resumed = true;
  }

  postDownloadProgress(
    request.id,
    request.fileName,
    tempPath,
    existingBytes,
    null,
    'downloading',
    resumed ? '检测到未完成下载，正在尝试续传...' : '正在开始下载模型...',
  );

  const response = await fetch(request.url, { headers });
  if (!response.ok && response.status !== 206) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }

  if (existingBytes > 0 && response.status === 200) {
    resumed = false;
    existingBytes = 0;
    storage.truncateFile(tempPath, 0);
  }

  const totalBytes = getTotalBytes(response, existingBytes);
  const stream = storage.openFile(tempPath, existingBytes > 0 ? 'a' : 'w');

  try {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('下载失败：响应体不可读');
    }

    let downloadedBytes = existingBytes;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      storage.writeChunk(stream, value);
      downloadedBytes += value.byteLength;
      postDownloadProgress(
        request.id,
        request.fileName,
        tempPath,
        downloadedBytes,
        totalBytes,
        'downloading',
        `正在下载 ${request.fileName}...`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postDownloadProgress(
      request.id,
      request.fileName,
      tempPath,
      existingBytes,
      totalBytes,
      'error',
      `下载失败：${message}`,
    );
    throw error;
  } finally {
    storage.closeFile(stream);
  }

  storage.renameFile(tempPath, finalPath);
  const entry = storage.statFile(finalPath);
  postDownloadProgress(
    request.id,
    request.fileName,
    finalPath,
    entry.size,
    entry.size,
    'completed',
    `${request.fileName} 下载完成`,
  );

  return {
    id: request.id,
    ok: true,
    type: 'download-model',
    entry,
    elapsedMs: performance.now() - startTime,
    resumed,
  };
}

workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    log('received message', request.type);
    if (!runtimePromise) {
      postStatus(request.id, getRequestStage(request.type), '正在初始化 WASM 运行时...');
    }
    const runtime = await getRuntime();

    if (request.type === 'list-storage') {
      const snapshot = listStorage(runtime.storage, runtime.fsInfo);
      workerScope.postMessage({ ...snapshot, id: request.id });
      return;
    }

    if (request.type === 'delete-storage-entry') {
      runtime.storage.deleteFile(request.path);
      const response: WorkerResponse = {
        id: request.id,
        ok: true,
        type: 'delete-storage-entry',
        path: request.path,
      };
      workerScope.postMessage(response);
      return;
    }

    if (request.type === 'read-storage-file') {
      const bytes = runtime.storage.readBinaryFile(request.path);
      const response: WorkerResponse = {
        id: request.id,
        ok: true,
        type: 'read-storage-file',
        path: request.path,
        data: toStandaloneArrayBuffer(bytes),
      };
      workerScope.postMessage(response, [response.data]);
      return;
    }

    if (request.type === 'save-generated-audio') {
      const stem = sanitizeFileStem(request.fileName);
      const targetPath = ensureUniqueFilePath(runtime.storage, `${runtime.storage.getRoot()}/audio`, `${stem}.wav`);
      runtime.storage.writeBinaryFile(targetPath, new Uint8Array(request.data));
      const response: WorkerResponse = {
        id: request.id,
        ok: true,
        type: 'save-generated-audio',
        entry: runtime.storage.statFile(targetPath),
      };
      workerScope.postMessage(response);
      return;
    }

    if (request.type === 'download-model') {
      postStatus(request.id, 'download-model', `准备下载 ${request.fileName} 到浏览器存储...`);
      const response = await handleDownloadModel(runtime, request);
      workerScope.postMessage(response);
      return;
    }

    if (request.type === 'load-model' || request.type === 'load-model-path') {
      const startTime = performance.now();
      let modelPath: string;

      if (request.type === 'load-model') {
        log('loading model', request.modelFile.name, 'threads=', request.threads);
        postStatus(request.id, 'load-model', `正在将 ${request.modelFile.name} 写入虚拟文件系统...`);
        modelPath = await runtime.session.writeModelFile(request.modelFile);
      } else {
        log('loading stored model', request.path, 'threads=', request.threads);
        modelPath = request.path;
      }

      postStatus(
        request.id,
        'load-model',
        `正在解析并加载模型权重（线程数 ${request.threads}）...`,
      );
      runtime.session.loadModel(modelPath, request.threads);
      log('model loaded');
      const response: WorkerResponse = {
        id: request.id,
        ok: true,
        type: 'load-model',
        path: modelPath,
        requiredPromptSampleRate: runtime.session.getRequiredPromptSampleRate(),
        elapsedMs: performance.now() - startTime,
      };
      workerScope.postMessage(response);
      return;
    }

    const startTime = performance.now();
    const promptAudio =
      request.promptAudio !== undefined ? new Float32Array(request.promptAudio) : undefined;
    postStatus(
      request.id,
      'synthesize',
      promptAudio && promptAudio.length > 0
        ? '正在执行推理并应用参考音频条件...'
        : '正在执行推理...',
    );
    log('starting synthesis', {
      textLength: request.text.length,
      hasPromptAudio: Boolean(promptAudio),
      inferenceTimesteps: request.inferenceTimesteps,
      cfgValue: request.cfgValue,
      seed: request.seed,
      maxDecodeSteps: request.maxDecodeSteps,
    });
    const result = runtime.session.synthesize({
      text: request.text,
      promptText: request.promptText,
      promptAudio,
      promptAudioSampleRate: request.promptAudioSampleRate,
      inferenceTimesteps: request.inferenceTimesteps,
      cfgValue: request.cfgValue,
      seed: request.seed,
      maxDecodeSteps: request.maxDecodeSteps,
    });
    log('synthesis done', {
      audioSamples: result.audio.length,
      sampleRate: result.sampleRate,
    });
    const response: WorkerResponse = {
      id: request.id,
      ok: true,
      type: 'synthesize',
      audio: viewToStandaloneArrayBuffer(result.audio),
      sampleRate: result.sampleRate,
      elapsedMs: performance.now() - startTime,
      audioDurationMs: (result.audio.length / result.sampleRate) * 1000,
    };
    workerScope.postMessage(response, [response.audio]);
  } catch (error) {
    logError('request failed', error);
    const response: WorkerResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    workerScope.postMessage(response);
  }
};
