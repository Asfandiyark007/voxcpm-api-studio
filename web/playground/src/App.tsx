import { useEffect, useMemo, useRef, useState } from 'react';

import { decodeAudioFile, encodeWav } from './utils/audio';

const isDev = typeof process !== 'undefined'
  ? process.env.NODE_ENV !== 'production'
  : true;

const REMOTE_MODEL_API = 'https://hf-mirror.com/api/models/bluryar/VoxCPM-GGUF/tree/main';
const REMOTE_MODEL_BASE = 'https://hf-mirror.com/bluryar/VoxCPM-GGUF/resolve/main/';

function devLog(...args: unknown[]): void {
  if (isDev) {
    console.log('[voxcpm-playground]', ...args);
  }
}

function devError(...args: unknown[]): void {
  console.error('[voxcpm-playground]', ...args);
}

function getCrossOriginIsolationMessage(): string {
  return '当前页面没有启用 cross-origin isolation，pthread 版 WASM 不能使用 SharedArrayBuffer。请重启 dev server，并确认响应头包含 Cross-Origin-Opener-Policy: same-origin 和 Cross-Origin-Embedder-Policy: require-corp。';
}

function getDefaultThreadCount(): number {
  if (typeof navigator === 'undefined' || !navigator.hardwareConcurrency) {
    return 4;
  }
  return Math.max(1, Math.min(8, navigator.hardwareConcurrency));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 10_000) {
    return `${(ms / 1000).toFixed(2)} s`;
  }
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatAudioDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(2)} s`;
  }
  return `${seconds.toFixed(1)} s`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) {
    return '未知大小';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stemFromFileName(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(0, dotIndex) : fileName;
}

type RemoteModelEntry = {
  path: string;
  name: string;
  size: number | null;
  downloadUrl: string;
};

type StoredEntry = {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  size: number;
  mtimeMs: number | null;
};

type StorageSnapshot = {
  backend: 'opfs' | 'idbfs' | 'memfs';
  root: string;
  models: StoredEntry[];
  audios: StoredEntry[];
  downloads: StoredEntry[];
};

type DownloadProgress = {
  fileName: string;
  path: string;
  downloadedBytes: number;
  totalBytes: number | null;
  progress: number | null;
  state: 'downloading' | 'completed' | 'error';
  message: string;
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

type WorkerPayload =
  | {
      type: 'load-model';
      modelFile: File;
      threads: number;
    }
  | {
      type: 'load-model-path';
      path: string;
      threads: number;
    }
  | {
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
      type: 'list-storage';
    }
  | {
      type: 'delete-storage-entry';
      path: string;
    }
  | {
      type: 'read-storage-file';
      path: string;
    }
  | {
      type: 'save-generated-audio';
      fileName: string;
      data: ArrayBuffer;
    }
  | {
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
      backend: 'opfs' | 'idbfs' | 'memfs';
      root: string;
      models: StoredEntry[];
      audios: StoredEntry[];
      downloads: StoredEntry[];
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
      entry: StoredEntry;
    }
  | {
      id: number;
      ok: true;
      type: 'download-model';
      entry: StoredEntry;
      elapsedMs: number;
      resumed: boolean;
    }
  | { id: number; ok: false; error: string };

type WorkerSideEvent = Extract<WorkerResponse, { type: 'status' | 'download-progress' }>;
type WorkerResult = Exclude<WorkerResponse, WorkerSideEvent>;

const worker = new Worker(new URL('./workers/voxcpm.worker.ts', import.meta.url), {
  type: 'module',
});

function normalizeRemoteModels(payload: unknown): RemoteModelEntry[] {
  const rawItems = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { siblings?: unknown[] })?.siblings)
      ? (payload as { siblings: unknown[] }).siblings
      : Array.isArray((payload as { items?: unknown[] })?.items)
        ? (payload as { items: unknown[] }).items
        : [];

  return rawItems
    .map((item) => {
      const path = typeof (item as { path?: unknown }).path === 'string'
        ? (item as { path: string }).path
        : null;
      if (!path || !path.endsWith('.gguf')) {
        return null;
      }
      const sizeValue = (item as { size?: unknown }).size;
      return {
        path,
        name: path.split('/').pop() ?? path,
        size: typeof sizeValue === 'number' ? sizeValue : null,
        downloadUrl: `${REMOTE_MODEL_BASE}${path}`,
      };
    })
    .filter((item): item is RemoteModelEntry => item !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function ensureArrayBuffer(buffer: ArrayBuffer | SharedArrayBuffer): ArrayBuffer {
  if (buffer instanceof ArrayBuffer) {
    return buffer.slice(0);
  }
  return buffer.slice(0) as unknown as ArrayBuffer;
}

function useWorkerRpc(onEvent?: (event: WorkerSideEvent) => void) {
  const idRef = useRef(0);
  const eventRef = useRef(onEvent);
  const pendingRef = useRef(
    new Map<number, { resolve: (value: WorkerResult) => void; reject: (error: Error) => void }>(),
  );

  useEffect(() => {
    eventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.ok && (message.type === 'status' || message.type === 'download-progress')) {
        eventRef.current?.(message);
        return;
      }

      const pending = pendingRef.current.get(message.id);
      if (!pending) {
        return;
      }

      pendingRef.current.delete(message.id);
      if (message.ok) {
        pending.resolve(message);
      } else {
        pending.reject(new Error(message.error));
      }
    };

    worker.addEventListener('message', handleMessage);
    return () => worker.removeEventListener('message', handleMessage);
  }, []);

  return (payload: WorkerPayload, transfer: Transferable[] = []) =>
    new Promise<WorkerResult>((resolve, reject) => {
      const id = ++idRef.current;
      devLog('postMessage', payload.type, { id });
      pendingRef.current.set(id, { resolve, reject });
      worker.postMessage({ ...payload, id }, transfer);
    });
}

export default function App() {
  const [activity, setActivity] = useState('等待加载模型');
  const [logs, setLogs] = useState<string[]>([
    '选择本地 GGUF 权重后，Playground 会把文件挂载到 Emscripten 的虚拟文件系统，再在 Worker 里完成推理。',
  ]);
  const [downloadMap, setDownloadMap] = useState<Record<string, DownloadProgress>>({});

  function pushLog(message: string): void {
    setLogs((current) => [message, ...current].slice(0, 60));
  }

  const send = useWorkerRpc((event) => {
    if (event.type === 'status') {
      devLog('status', event.stage, event.message);
      setActivity(event.message);
      pushLog(event.message);
      return;
    }
    devLog('download-progress', event.fileName, event);
    setDownloadMap((current) => ({
      ...current,
      [event.fileName]: event,
    }));
  });

  const isCrossOriginIsolated =
    typeof window !== 'undefined' ? window.crossOriginIsolated : false;
  const recommendedThreads = useMemo(() => getDefaultThreadCount(), []);

  const [storage, setStorage] = useState<StorageSnapshot | null>(null);
  const [remoteModels, setRemoteModels] = useState<RemoteModelEntry[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const [modelFile, setModelFile] = useState<File | null>(null);
  const [modelReady, setModelReady] = useState(false);
  const [loadedModelPath, setLoadedModelPath] = useState<string | null>(null);
  const [requiredPromptSampleRate, setRequiredPromptSampleRate] = useState<number | null>(null);
  const [modelLoadMs, setModelLoadMs] = useState<number | null>(null);

  const [promptFile, setPromptFile] = useState<File | null>(null);
  const [storedPromptAudioPath, setStoredPromptAudioPath] = useState<string | null>(null);
  const [storedPromptAudioName, setStoredPromptAudioName] = useState<string | null>(null);

  const [text, setText] = useState('大家好，我现在正在浏览器里体验 VoxCPM 的 WASM 推理。');
  const [promptText, setPromptText] = useState('对，这就是我，万人敬仰的太乙真人。');
  const [threads, setThreads] = useState(getDefaultThreadCount);
  const [inferenceTimesteps, setInferenceTimesteps] = useState(10);
  const [cfgValue, setCfgValue] = useState(2);
  const [seed, setSeed] = useState(1337);
  const [maxDecodeSteps, setMaxDecodeSteps] = useState(0);

  const [busyAction, setBusyAction] = useState<'load-model' | 'synthesize' | 'load-stored-model' | null>(null);
  const [synthesisMs, setSynthesisMs] = useState<number | null>(null);
  const [outputDurationMs, setOutputDurationMs] = useState<number | null>(null);
  const [outputSampleRate, setOutputSampleRate] = useState<number | null>(null);

  const [resultAudioUrl, setResultAudioUrl] = useState<string | null>(null);
  const [libraryAudioUrl, setLibraryAudioUrl] = useState<string | null>(null);
  const [libraryAudioLabel, setLibraryAudioLabel] = useState<string | null>(null);

  const hfLinks = useMemo(
    () => ({
      repo: 'https://huggingface.co/bluryar/VoxCPM-GGUF',
      mirror:
        'https://hf-mirror.com/bluryar/VoxCPM-GGUF/resolve/main/voxcpm-0.5b-q4_k.gguf',
    }),
    [],
  );

  useEffect(() => {
    devLog('crossOriginIsolated=', isCrossOriginIsolated);
    if (!isCrossOriginIsolated) {
      const message = getCrossOriginIsolationMessage();
      setLogs((current) => (current.includes(message) ? current : [message, ...current]));
    }
  }, [isCrossOriginIsolated]);

  useEffect(() => {
    return () => {
      if (resultAudioUrl) {
        URL.revokeObjectURL(resultAudioUrl);
      }
      if (libraryAudioUrl) {
        URL.revokeObjectURL(libraryAudioUrl);
      }
    };
  }, [libraryAudioUrl, resultAudioUrl]);

  async function refreshStorage(): Promise<void> {
    try {
      const response = await send({ type: 'list-storage' });
      if (response.ok && response.type === 'list-storage') {
        setStorage(response);
      }
    } catch (error) {
      devError('list storage failed', error);
      pushLog(`读取浏览器存储失败：${toErrorMessage(error)}`);
    }
  }

  async function refreshRemoteModels(): Promise<void> {
    setRemoteLoading(true);
    setRemoteError(null);
    try {
      const response = await fetch(REMOTE_MODEL_API);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      setRemoteModels(normalizeRemoteModels(payload));
    } catch (error) {
      const message = `读取远程模型列表失败：${toErrorMessage(error)}`;
      setRemoteError(message);
      pushLog(message);
    } finally {
      setRemoteLoading(false);
    }
  }

  useEffect(() => {
    void refreshStorage();
    void refreshRemoteModels();
  }, []);

  useEffect(() => {
    setModelReady(false);
    setLoadedModelPath(null);
    setRequiredPromptSampleRate(null);
    setModelLoadMs(null);
    if (modelFile) {
      setActivity(`已选择本地模型 ${modelFile.name}，等待加载`);
    }
  }, [modelFile]);

  async function handleLoadLocalModel() {
    if (!modelFile) {
      pushLog('请先选择 GGUF 模型文件。');
      return;
    }
    if (!isCrossOriginIsolated) {
      const message = getCrossOriginIsolationMessage();
      devError(message);
      pushLog(message);
      return;
    }

    setBusyAction('load-model');
    setModelReady(false);
    setActivity(`正在加载模型 ${modelFile.name}`);
    pushLog(`正在加载本地模型 ${modelFile.name}...`);
    try {
      const response = await send({
        type: 'load-model',
        modelFile,
        threads,
      });
      if (response.ok && response.type === 'load-model') {
        devLog('model loaded', response);
        setModelReady(true);
        setLoadedModelPath(response.path);
        setRequiredPromptSampleRate(response.requiredPromptSampleRate);
        setModelLoadMs(response.elapsedMs);
        setActivity('模型已加载，可以开始推理');
        pushLog(
          `本地模型已加载，用时 ${formatDuration(response.elapsedMs)}，参考音频将自动重采样到 ${response.requiredPromptSampleRate} Hz。`,
        );
      }
    } catch (error) {
      devError('model load failed', error);
      setActivity('模型加载失败');
      pushLog(`模型加载失败：${toErrorMessage(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleLoadStoredModel(path: string) {
    setBusyAction('load-stored-model');
    setModelReady(false);
    setActivity(`正在切换到 ${path.split('/').pop() ?? path}`);
    pushLog(`正在从浏览器存储加载模型 ${path}...`);
    try {
      const response = await send({
        type: 'load-model-path',
        path,
        threads,
      });
      if (response.ok && response.type === 'load-model') {
        setModelReady(true);
        setLoadedModelPath(response.path);
        setRequiredPromptSampleRate(response.requiredPromptSampleRate);
        setModelLoadMs(response.elapsedMs);
        setActivity('已从浏览器存储切换模型');
        pushLog(`模型切换完成，用时 ${formatDuration(response.elapsedMs)}。`);
      }
    } catch (error) {
      devError('stored model load failed', error);
      setActivity('模型切换失败');
      pushLog(`模型切换失败：${toErrorMessage(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDownloadModel(entry: RemoteModelEntry) {
    setDownloadMap((current) => ({
      ...current,
      [entry.name]: {
        fileName: entry.name,
        path: entry.path,
        downloadedBytes: 0,
        totalBytes: entry.size,
        progress: 0,
        state: 'downloading',
        message: `准备下载 ${entry.name}`,
      },
    }));

    try {
      const response = await send({
        type: 'download-model',
        url: entry.downloadUrl,
        fileName: entry.name,
      });
      if (response.ok && response.type === 'download-model') {
        pushLog(
          `${entry.name} 下载完成，用时 ${formatDuration(response.elapsedMs)}${response.resumed ? '（已续传）' : ''}。`,
        );
        await refreshStorage();
      }
    } catch (error) {
      devError('download model failed', error);
      pushLog(`下载失败：${entry.name} - ${toErrorMessage(error)}`);
      setDownloadMap((current) => ({
        ...current,
        [entry.name]: {
          ...(current[entry.name] ?? {
            fileName: entry.name,
            path: entry.path,
            downloadedBytes: 0,
            totalBytes: entry.size,
            progress: 0,
          }),
          state: 'error',
          message: toErrorMessage(error),
        },
      }));
    }
  }

  async function readStoredAudio(path: string): Promise<File> {
    const response = await send({ type: 'read-storage-file', path });
    if (!response.ok || response.type !== 'read-storage-file') {
      throw new Error('无法读取存储中的音频文件');
    }
    return new File([response.data], path.split('/').pop() ?? 'audio.wav', { type: 'audio/wav' });
  }

  async function handlePlayStoredAudio(entry: StoredEntry) {
    try {
      const file = await readStoredAudio(entry.path);
      const nextUrl = URL.createObjectURL(file);
      if (libraryAudioUrl) {
        URL.revokeObjectURL(libraryAudioUrl);
      }
      setLibraryAudioUrl(nextUrl);
      setLibraryAudioLabel(entry.name);
      pushLog(`正在播放 ${entry.name}`);
    } catch (error) {
      pushLog(`播放音频失败：${toErrorMessage(error)}`);
    }
  }

  function handleUseStoredAudioAsPrompt(entry: StoredEntry) {
    setStoredPromptAudioPath(entry.path);
    setStoredPromptAudioName(entry.name);
    setPromptFile(null);
    setPromptText(stemFromFileName(entry.name));
    pushLog(`已选择 ${entry.name} 作为参考音频。`);
  }

  async function handleDeleteEntry(entry: StoredEntry) {
    try {
      await send({
        type: 'delete-storage-entry',
        path: entry.path,
      });
      if (storedPromptAudioPath === entry.path) {
        setStoredPromptAudioPath(null);
        setStoredPromptAudioName(null);
      }
      pushLog(`已删除 ${entry.name}`);
      await refreshStorage();
    } catch (error) {
      pushLog(`删除失败：${toErrorMessage(error)}`);
    }
  }

  async function handleSynthesize() {
    if (!modelReady) {
      pushLog('请先加载 GGUF 模型。');
      return;
    }

    setBusyAction('synthesize');
    setActivity('正在准备推理请求');
    pushLog('开始推理，这一步会在 Worker 中执行。');
    try {
      let promptAudioBuffer: ArrayBuffer | undefined;
      let promptAudioSampleRate: number | undefined;

      if (promptFile) {
        setActivity(`正在解码参考音频 ${promptFile.name}`);
        pushLog(`正在解码参考音频 ${promptFile.name}...`);
        const decoded = await decodeAudioFile(promptFile);
        promptAudioBuffer = ensureArrayBuffer(decoded.samples.buffer);
        promptAudioSampleRate = decoded.sampleRate;
        pushLog(`参考音频解码完成，原始采样率 ${decoded.sampleRate} Hz。`);
      } else if (storedPromptAudioPath) {
        setActivity(`正在读取存储中的参考音频 ${storedPromptAudioName ?? storedPromptAudioPath}`);
        const storedFile = await readStoredAudio(storedPromptAudioPath);
        const decoded = await decodeAudioFile(storedFile);
        promptAudioBuffer = ensureArrayBuffer(decoded.samples.buffer);
        promptAudioSampleRate = decoded.sampleRate;
        pushLog(`已读取浏览器存储中的参考音频 ${storedPromptAudioName ?? storedPromptAudioPath}。`);
      }

      const response = await send(
        {
          type: 'synthesize',
          text,
          promptText,
          promptAudio: promptAudioBuffer,
          promptAudioSampleRate,
          inferenceTimesteps,
          cfgValue,
          seed,
          maxDecodeSteps,
        },
        promptAudioBuffer ? [promptAudioBuffer] : [],
      );

      if (response.ok && response.type === 'synthesize') {
        devLog('synthesis result', response);
        const wav = encodeWav(new Float32Array(response.audio), response.sampleRate);
        const wavArrayBuffer = await wav.arrayBuffer();

        if (resultAudioUrl) {
          URL.revokeObjectURL(resultAudioUrl);
        }
        const nextUrl = URL.createObjectURL(wav);
        setResultAudioUrl(nextUrl);

        setSynthesisMs(response.elapsedMs);
        setOutputDurationMs(response.audioDurationMs);
        setOutputSampleRate(response.sampleRate);
        setActivity('推理完成');
        pushLog(
          `推理完成，用时 ${formatDuration(response.elapsedMs)}，输出音频 ${formatAudioDuration(response.audioDurationMs)}，采样率 ${response.sampleRate} Hz。`,
        );

        const saveResponse = await send(
          {
            type: 'save-generated-audio',
            fileName: text.trim() || 'untitled',
            data: wavArrayBuffer,
          },
          [wavArrayBuffer],
        );
        if (saveResponse.ok && saveResponse.type === 'save-generated-audio') {
          pushLog(`已保存生成音频到浏览器存储：${saveResponse.entry.name}`);
          await refreshStorage();
        }
      }
    } catch (error) {
      devError('synthesis failed', error);
      setActivity('推理失败');
      pushLog(`推理失败：${toErrorMessage(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  const modelNamesInStorage = useMemo(
    () => new Set(storage?.models.map((entry) => entry.name) ?? []),
    [storage],
  );

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-8 md:px-8">
      <section className="overflow-hidden rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] shadow-[0_25px_80px_rgba(80,49,20,0.12)] backdrop-blur">
        <div className="grid gap-6 p-6 md:grid-cols-[1.15fr_0.85fr] md:p-10">
          <div className="space-y-5">
            <p className="text-sm uppercase tracking-[0.35em] text-[var(--accent)]">VoxCPM.cpp</p>
            <h1 className="max-w-3xl text-4xl font-semibold leading-tight md:text-6xl">
              浏览器里的 VoxCPM OPFS Playground
            </h1>
            <p className="max-w-2xl text-base leading-7 text-black/70 md:text-lg">
              现在这版已经支持 pthread + WebAssembly SIMD 推理，并准备把模型和生成音频持续保存在
              浏览器内部文件系统里。权重可以直接下载到浏览器存储，不再依赖本地文件系统。
            </p>
            <div className="flex flex-wrap gap-3 text-sm font-medium">
              <a
                className="rounded-full border border-[var(--ink)] px-4 py-2 text-[var(--ink)] transition hover:bg-[var(--ink)] hover:text-white"
                href={hfLinks.repo}
                target="_blank"
                rel="noreferrer"
              >
                Hugging Face 仓库
              </a>
              <a
                className="rounded-full bg-[var(--accent)] px-4 py-2 text-white transition hover:translate-y-[-1px]"
                href={hfLinks.mirror}
                target="_blank"
                rel="noreferrer"
              >
                镜像直链：voxcpm-0.5b-q4_k.gguf
              </a>
            </div>
          </div>

          <div className="rounded-[1.5rem] border border-[var(--line)] bg-white/70 p-5">
            <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[var(--accent)]">
              当前状态
            </p>
            <div className="mt-4 space-y-3 text-sm leading-6 text-black/75">
              <p>运行状态：{activity}</p>
              <p>crossOriginIsolated：{isCrossOriginIsolated ? 'true' : 'false'}</p>
              <p>推荐线程数：{recommendedThreads}</p>
              <p>存储后端：{storage?.backend ?? '初始化中'}</p>
              <p>存储根目录：{storage?.root ?? '初始化中'}</p>
            </div>
            <div className="mt-5 rounded-2xl bg-[#1d1a16] p-4 text-sm text-[#f6eede]">
              <p>注意</p>
              <p className="mt-2 text-[#f6eede]/80">
                `Q4_K` 权重约 477 MB。建议使用桌面 Chrome 或 Edge，并保留足够磁盘空间给浏览器 OPFS。
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[var(--accent)]">
                  远程模型
                </p>
                <p className="mt-2 text-sm text-black/65">
                  通过 HF mirror 拉取可下载的 GGUF 列表，直接下载到浏览器存储。
                </p>
              </div>
              <button
                className="rounded-full border border-[var(--ink)] px-4 py-2 text-sm font-medium"
                type="button"
                onClick={() => void refreshRemoteModels()}
                disabled={remoteLoading}
              >
                {remoteLoading ? '刷新中…' : '刷新列表'}
              </button>
            </div>

            {remoteError ? (
              <p className="mt-4 rounded-2xl bg-[#f8ded3] px-4 py-3 text-sm text-[#8d4321]">
                {remoteError}
              </p>
            ) : null}

            <div className="mt-4 grid gap-3">
              {remoteModels.map((entry) => {
                const progress = downloadMap[entry.name];
                const exists = modelNamesInStorage.has(entry.name);
                return (
                  <div
                    key={entry.path}
                    className="rounded-[1.5rem] border border-[var(--line)] bg-white/80 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-[var(--ink)]">{entry.name}</p>
                        <p className="mt-1 text-sm text-black/60">{formatBytes(entry.size)}</p>
                      </div>
                      <button
                        className={`rounded-full px-4 py-2 text-sm font-medium text-white transition ${
                          exists
                            ? 'bg-[#3f7c58]'
                            : progress?.state === 'downloading'
                              ? 'bg-[#8d4321]'
                              : 'bg-[var(--accent)]'
                        }`}
                        type="button"
                        onClick={() => void handleDownloadModel(entry)}
                        disabled={progress?.state === 'downloading'}
                      >
                        {exists
                          ? '重新下载'
                          : progress?.state === 'downloading'
                            ? '下载中…'
                            : '下载到浏览器'}
                      </button>
                    </div>

                    {progress ? (
                      <div className="mt-3 space-y-2">
                        <div className="h-2 overflow-hidden rounded-full bg-[#eadfd4]">
                          <div
                            className={`h-full rounded-full transition-all ${
                              progress.state === 'completed'
                                ? 'bg-[#3f7c58]'
                                : progress.state === 'error'
                                  ? 'bg-[#b5442d]'
                                  : 'bg-[var(--accent)]'
                            }`}
                            style={{
                              width: `${Math.max(4, Math.round((progress.progress ?? 0) * 100))}%`,
                            }}
                          />
                        </div>
                        <p className="text-sm text-black/65">
                          {progress.message} {formatBytes(progress.downloadedBytes)}
                          {progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''}
                        </p>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] p-6">
            <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[var(--accent)]">
              推理控制
            </p>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-2 text-sm font-medium">
                本地 GGUF 模型
                <input
                  className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3"
                  type="file"
                  accept=".gguf"
                  onChange={(event) => setModelFile(event.target.files?.[0] ?? null)}
                />
              </label>
              <label className="flex flex-col gap-2 text-sm font-medium">
                本地参考音频
                <input
                  className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3"
                  type="file"
                  accept="audio/*,.wav"
                  onChange={(event) => {
                    setPromptFile(event.target.files?.[0] ?? null);
                    setStoredPromptAudioPath(null);
                    setStoredPromptAudioName(null);
                  }}
                />
              </label>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-2 text-sm font-medium">
                线程数
                <input
                  className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3"
                  type="number"
                  min={1}
                  max={8}
                  value={threads}
                  onChange={(event) =>
                    setThreads(clampNumber(Number(event.target.value) || 1, 1, 8))
                  }
                />
              </label>
              <label className="flex flex-col gap-2 text-sm font-medium">
                Inference Timesteps
                <input
                  className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3"
                  type="number"
                  min={1}
                  max={20}
                  value={inferenceTimesteps}
                  onChange={(event) => setInferenceTimesteps(Number(event.target.value))}
                />
              </label>
              <label className="flex flex-col gap-2 text-sm font-medium">
                CFG
                <input
                  className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3"
                  type="number"
                  min={0}
                  step="0.1"
                  value={cfgValue}
                  onChange={(event) => setCfgValue(Number(event.target.value))}
                />
              </label>
              <label className="flex flex-col gap-2 text-sm font-medium">
                Seed
                <input
                  className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3"
                  type="number"
                  value={seed}
                  onChange={(event) => setSeed(Number(event.target.value))}
                />
              </label>
            </div>

            <label className="mt-4 flex flex-col gap-2 text-sm font-medium">
              参考文本
              <textarea
                className="min-h-28 rounded-[1.5rem] border border-[var(--line)] bg-white px-4 py-3"
                value={promptText}
                onChange={(event) => setPromptText(event.target.value)}
              />
            </label>

            <label className="mt-4 flex flex-col gap-2 text-sm font-medium">
              目标文本
              <textarea
                className="min-h-36 rounded-[1.5rem] border border-[var(--line)] bg-white px-4 py-3"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </label>

            <label className="mt-4 flex flex-col gap-2 text-sm font-medium">
              最大解码步数
              <input
                className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3"
                type="number"
                min={0}
                value={maxDecodeSteps}
                onChange={(event) => setMaxDecodeSteps(Number(event.target.value))}
              />
            </label>

            <div className="mt-4 flex flex-wrap gap-3">
              <button
                className="rounded-full border border-[var(--ink)] px-5 py-3 text-sm font-semibold transition hover:bg-[var(--ink)] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                type="button"
                onClick={() => void handleLoadLocalModel()}
                disabled={busyAction !== null}
              >
                {busyAction === 'load-model' ? '加载中…' : '加载本地模型'}
              </button>
              <button
                className="rounded-full bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-white transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-50"
                type="button"
                onClick={() => void handleSynthesize()}
                disabled={busyAction !== null || !modelReady}
              >
                {busyAction === 'synthesize' ? '推理中…' : '开始推理'}
              </button>
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] p-6">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[var(--accent)]">
                浏览器存储
              </p>
              <button
                className="rounded-full border border-[var(--ink)] px-4 py-2 text-sm font-medium"
                type="button"
                onClick={() => void refreshStorage()}
              >
                刷新
              </button>
            </div>

            <div className="mt-4 space-y-5 text-sm text-black/70">
              <div>
                <p className="font-semibold text-[var(--ink)]">权重</p>
                <div className="mt-3 space-y-3">
                  {storage?.models.length ? storage.models.map((entry) => (
                    <div
                      key={entry.path}
                      className="rounded-[1.25rem] border border-[var(--line)] bg-white/80 p-4"
                    >
                      <p className="font-medium text-[var(--ink)]">{entry.name}</p>
                      <p className="mt-1 text-xs text-black/55">{formatBytes(entry.size)}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          className="rounded-full bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white"
                          type="button"
                          onClick={() => void handleLoadStoredModel(entry.path)}
                          disabled={busyAction !== null}
                        >
                          加载
                        </button>
                        <button
                          className="rounded-full border border-[var(--ink)] px-3 py-2 text-xs font-semibold"
                          type="button"
                          onClick={() => void handleDeleteEntry(entry)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  )) : <p>暂无已下载权重。</p>}
                </div>
              </div>

              <div>
                <p className="font-semibold text-[var(--ink)]">音频</p>
                <div className="mt-3 space-y-3">
                  {storage?.audios.length ? storage.audios.map((entry) => (
                    <div
                      key={entry.path}
                      className="rounded-[1.25rem] border border-[var(--line)] bg-white/80 p-4"
                    >
                      <p className="font-medium text-[var(--ink)]">{stemFromFileName(entry.name)}</p>
                      <p className="mt-1 text-xs text-black/55">{formatBytes(entry.size)}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          className="rounded-full bg-[#3f7c58] px-3 py-2 text-xs font-semibold text-white"
                          type="button"
                          onClick={() => void handlePlayStoredAudio(entry)}
                        >
                          播放
                        </button>
                        <button
                          className="rounded-full border border-[var(--ink)] px-3 py-2 text-xs font-semibold"
                          type="button"
                          onClick={() => handleUseStoredAudioAsPrompt(entry)}
                        >
                          设为参考
                        </button>
                        <button
                          className="rounded-full border border-[var(--ink)] px-3 py-2 text-xs font-semibold"
                          type="button"
                          onClick={() => void handleDeleteEntry(entry)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  )) : <p>暂无已保存音频。</p>}
                </div>
              </div>

              <div>
                <p className="font-semibold text-[var(--ink)]">下载缓存</p>
                <div className="mt-3 space-y-3">
                  {storage?.downloads.length ? storage.downloads.map((entry) => (
                    <div
                      key={entry.path}
                      className="rounded-[1.25rem] border border-[var(--line)] bg-white/80 p-4"
                    >
                      <p className="font-medium text-[var(--ink)]">{entry.name}</p>
                      <p className="mt-1 text-xs text-black/55">{formatBytes(entry.size)}</p>
                    </div>
                  )) : <p>暂无断点续传缓存。</p>}
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] p-6">
            <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[var(--accent)]">
              运行信息
            </p>
            <div className="mt-4 space-y-2 text-sm text-black/70">
              <p>模型就绪：{modelReady ? '是' : '否'}</p>
              <p>当前模型路径：{loadedModelPath ?? '未加载'}</p>
              <p>参考音频：{promptFile?.name ?? storedPromptAudioName ?? '未选择'}</p>
              <p>参考采样率要求：{requiredPromptSampleRate ?? '加载模型后可见'}</p>
              <p>模型加载耗时：{modelLoadMs !== null ? formatDuration(modelLoadMs) : '暂无'}</p>
              <p>最近推理耗时：{synthesisMs !== null ? formatDuration(synthesisMs) : '暂无'}</p>
              <p>
                最近输出音频：
                {outputDurationMs !== null && outputSampleRate !== null
                  ? `${formatAudioDuration(outputDurationMs)} / ${outputSampleRate} Hz`
                  : '暂无'}
              </p>
            </div>
          </section>

          <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--panel)] p-6">
            <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[var(--accent)]">
              音频播放器
            </p>
            <div className="mt-4 space-y-5">
              <div>
                <p className="text-sm font-medium text-[var(--ink)]">最新推理结果</p>
                {resultAudioUrl ? (
                  <div className="mt-3 space-y-3">
                    <audio controls className="w-full" src={resultAudioUrl} />
                    <a
                      className="inline-flex rounded-full border border-[var(--ink)] px-4 py-2 text-sm font-medium"
                      href={resultAudioUrl}
                      download="voxcpm-output.wav"
                    >
                      下载 WAV
                    </a>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-black/60">推理完成后会在这里生成播放器。</p>
                )}
              </div>

              <div>
                <p className="text-sm font-medium text-[var(--ink)]">
                  存储中的音频 {libraryAudioLabel ? `· ${libraryAudioLabel}` : ''}
                </p>
                {libraryAudioUrl ? (
                  <audio controls className="mt-3 w-full" src={libraryAudioUrl} />
                ) : (
                  <p className="mt-2 text-sm text-black/60">点击“播放”后会在这里切换音频。</p>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-[2rem] border border-[var(--line)] bg-[#16120f] p-6 text-[#f6eede]">
            <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[#f2c8a1]">
              日志
            </p>
            <div className="mt-4 max-h-72 space-y-3 overflow-auto text-sm leading-6">
              {logs.map((line, index) => (
                <p key={`${line}-${index}`}>{line}</p>
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
