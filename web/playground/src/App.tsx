import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { decodeAudioBlob, encodeWav } from './utils/audio';

type VoiceMetadata = {
  id: string;
  prompt_text: string;
  prompt_audio_length: number;
  sample_rate: number;
  patch_size: number;
  feat_dim: number;
  created_at: string;
  updated_at: string;
};

type ResponseFormat = 'wav' | 'mp3' | 'flac' | 'pcm';
type HealthState = 'unknown' | 'checking' | 'online' | 'offline';

const LOCAL_STORAGE_VOICES = 'voxcpm-api-ui-voices';
const MAX_LOG_LINES = 120;
const VOICE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function normalizeApiBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function buildApiUrl(baseUrl: string, path: string): string {
  const normalized = normalizeApiBaseUrl(baseUrl);
  if (!normalized) {
    return path;
  }

  if (
    normalized.startsWith('http://') ||
    normalized.startsWith('https://') ||
    normalized.startsWith('/')
  ) {
    return `${normalized}${path}`;
  }

  return `http://${normalized}${path}`;
}

function buildAuthHeaders(apiKey: string): Record<string, string> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return {};
  }
  return {
    Authorization: `Bearer ${trimmed}`,
  };
}

async function readApiError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `HTTP ${response.status}`;
  }

  try {
    const payload = JSON.parse(text) as {
      error?: {
        message?: string;
      };
    };
    if (payload.error?.message) {
      return payload.error.message;
    }
  } catch {
    // Keep the original text fallback.
  }

  if (text.length > 280) {
    return `${text.slice(0, 277)}...`;
  }
  return text;
}

function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) {
    return 1.0;
  }
  return Math.min(4.0, Math.max(0.25, value));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatElapsed(ms: number | null): string {
  if (ms === null) {
    return '--';
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createDownloadName(voiceId: string, responseFormat: ResponseFormat): string {
  const safeVoice = voiceId.trim().replace(/[^a-zA-Z0-9._-]/g, '_') || 'voice';
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\.\d+Z$/, 'Z');
  return `voxcpm-${safeVoice}-${stamp}.${responseFormat}`;
}

function clampSegmentChars(value: number): number {
  if (!Number.isFinite(value)) {
    return 180;
  }
  return Math.min(600, Math.max(60, Math.round(value)));
}

function splitOverlongSentence(sentence: string, maxChars: number): string[] {
  const normalized = sentence.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const commaParts = normalized
    .split(/(?<=[,，;；:：、])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const chunks: string[] = [];
  let current = '';

  for (const part of commaParts.length > 0 ? commaParts : [normalized]) {
    const candidate = current ? `${current} ${part}` : part;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (part.length <= maxChars) {
      current = part;
      continue;
    }

    for (let start = 0; start < part.length; start += maxChars) {
      chunks.push(part.slice(start, start + maxChars));
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitLongTextForSynthesis(text: string, maxChars: number): string[] {
  const normalizedText = text.replace(/\r/g, '').trim();
  if (!normalizedText) {
    return [];
  }

  const sentenceMatches =
    normalizedText.match(/[^.!?。！？\n]+[.!?。！？]?/g)?.map((item) => item.trim()) ?? [];
  const seedSentences = sentenceMatches.length > 0 ? sentenceMatches : [normalizedText];

  const fineSentences = seedSentences.flatMap((sentence) =>
    splitOverlongSentence(sentence, maxChars),
  );

  const merged: string[] = [];
  let current = '';

  for (const sentence of fineSentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      merged.push(current);
    }
    current = sentence;
  }

  if (current) {
    merged.push(current);
  }

  return merged;
}

function concatFloat32Arrays(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export default function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState('/api');
  const [apiKey, setApiKey] = useState('');
  const [modelName, setModelName] = useState('voxcpm-1.5');

  const [healthState, setHealthState] = useState<HealthState>('unknown');
  const [healthMessage, setHealthMessage] = useState('Not checked yet');

  const [knownVoiceIds, setKnownVoiceIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_VOICES);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
    } catch {
      return [];
    }
  });

  const [voiceDetails, setVoiceDetails] = useState<Record<string, VoiceMetadata>>({});
  const [registerVoiceId, setRegisterVoiceId] = useState('taiyi');
  const [registerPromptText, setRegisterPromptText] = useState(
    'This is my reference transcript used to register the voice.',
  );
  const [registerAudioFile, setRegisterAudioFile] = useState<File | null>(null);
  const [voiceLookupId, setVoiceLookupId] = useState('taiyi');

  const [voiceForTts, setVoiceForTts] = useState('taiyi');
  const [ttsInput, setTtsInput] = useState(
    'Hello from VoxCPM.cpp API frontend. This sentence is generated through the local server.',
  );
  const [responseFormat, setResponseFormat] = useState<ResponseFormat>('wav');
  const [speed, setSpeed] = useState(1.0);
  const [longTextMode, setLongTextMode] = useState(true);
  const [maxSegmentChars, setMaxSegmentChars] = useState(180);

  const [busyAction, setBusyAction] = useState<
    null | 'health' | 'register' | 'lookup' | 'delete' | 'synthesize'
  >(null);
  const [logs, setLogs] = useState<string[]>([
    'Ready. Start by checking /healthz, then register a voice, then synthesize.',
  ]);

  const [resultAudioUrl, setResultAudioUrl] = useState<string | null>(null);
  const [resultAudioMime, setResultAudioMime] = useState('audio/wav');
  const [resultDownloadFormat, setResultDownloadFormat] = useState<ResponseFormat>('wav');
  const [resultAudioBytes, setResultAudioBytes] = useState<number | null>(null);
  const [lastSynthesisMs, setLastSynthesisMs] = useState<number | null>(null);

  function pushLog(message: string): void {
    const now = new Date().toLocaleTimeString();
    setLogs((current) => [`${now}  ${message}`, ...current].slice(0, MAX_LOG_LINES));
  }

  function addKnownVoice(id: string): void {
    setKnownVoiceIds((current) => {
      const deduped = Array.from(new Set([...current, id]));
      deduped.sort((a, b) => a.localeCompare(b));
      return deduped;
    });
  }

  function removeKnownVoice(id: string): void {
    setKnownVoiceIds((current) => current.filter((voice) => voice !== id));
  }

  useEffect(() => {
    localStorage.setItem(LOCAL_STORAGE_VOICES, JSON.stringify(knownVoiceIds));
  }, [knownVoiceIds]);

  useEffect(() => {
    return () => {
      if (resultAudioUrl) {
        URL.revokeObjectURL(resultAudioUrl);
      }
    };
  }, [resultAudioUrl]);

  async function handleHealthCheck(): Promise<void> {
    setBusyAction('health');
    setHealthState('checking');
    setHealthMessage('Checking server...');
    const url = buildApiUrl(apiBaseUrl, '/healthz');
    try {
      const response = await fetch(url, {
        headers: {
          ...buildAuthHeaders(apiKey),
        },
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const payload = (await response.json()) as { status?: string };
      setHealthState('online');
      setHealthMessage(payload.status === 'ok' ? 'Server is healthy' : 'Server responded');
      pushLog(`Health check succeeded via ${url}.`);
    } catch (error) {
      const message = toErrorMessage(error);
      setHealthState('offline');
      setHealthMessage(message);
      pushLog(`Health check failed: ${message}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRegisterVoice(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const voiceId = registerVoiceId.trim();
    const prompt = registerPromptText.trim();

    if (!VOICE_ID_PATTERN.test(voiceId)) {
      pushLog('Voice id must match [A-Za-z0-9._-].');
      return;
    }
    if (!prompt) {
      pushLog('Reference transcript is required.');
      return;
    }
    if (!registerAudioFile) {
      pushLog('Reference audio file is required.');
      return;
    }

    setBusyAction('register');
    try {
      const formData = new FormData();
      formData.append('id', voiceId);
      formData.append('text', prompt);
      formData.append('audio', registerAudioFile);

      const response = await fetch(buildApiUrl(apiBaseUrl, '/v1/voices'), {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(apiKey),
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      const metadata = (await response.json()) as VoiceMetadata;
      setVoiceDetails((current) => ({
        ...current,
        [metadata.id]: metadata,
      }));
      addKnownVoice(metadata.id);
      setVoiceLookupId(metadata.id);
      setVoiceForTts(metadata.id);
      pushLog(`Voice registered: ${metadata.id}`);
    } catch (error) {
      pushLog(`Voice registration failed: ${toErrorMessage(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleLookupVoice(): Promise<void> {
    const voiceId = voiceLookupId.trim();
    if (!VOICE_ID_PATTERN.test(voiceId)) {
      pushLog('Enter a valid voice id before lookup.');
      return;
    }

    setBusyAction('lookup');
    try {
      const response = await fetch(buildApiUrl(apiBaseUrl, `/v1/voices/${encodeURIComponent(voiceId)}`), {
        headers: {
          ...buildAuthHeaders(apiKey),
        },
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      const metadata = (await response.json()) as VoiceMetadata;
      setVoiceDetails((current) => ({
        ...current,
        [metadata.id]: metadata,
      }));
      addKnownVoice(metadata.id);
      pushLog(`Voice metadata loaded: ${metadata.id}`);
    } catch (error) {
      pushLog(`Voice lookup failed: ${toErrorMessage(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDeleteVoice(): Promise<void> {
    const voiceId = voiceLookupId.trim();
    if (!VOICE_ID_PATTERN.test(voiceId)) {
      pushLog('Enter a valid voice id before delete.');
      return;
    }

    const confirmed = window.confirm(`Delete voice \"${voiceId}\" from server storage?`);
    if (!confirmed) {
      return;
    }

    setBusyAction('delete');
    try {
      const response = await fetch(buildApiUrl(apiBaseUrl, `/v1/voices/${encodeURIComponent(voiceId)}`), {
        method: 'DELETE',
        headers: {
          ...buildAuthHeaders(apiKey),
        },
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      setVoiceDetails((current) => {
        const next = { ...current };
        delete next[voiceId];
        return next;
      });
      removeKnownVoice(voiceId);

      if (voiceForTts === voiceId) {
        setVoiceForTts('');
      }

      pushLog(`Voice deleted: ${voiceId}`);
    } catch (error) {
      pushLog(`Voice delete failed: ${toErrorMessage(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSynthesize(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const voiceId = voiceForTts.trim();
    const input = ttsInput.trim();
    const model = modelName.trim();

    if (!model) {
      pushLog('Model name is required.');
      return;
    }
    if (!VOICE_ID_PATTERN.test(voiceId)) {
      pushLog('Enter a valid voice id before synthesis.');
      return;
    }
    if (!input) {
      pushLog('Input text is required.');
      return;
    }

    const segmentCharLimit = clampSegmentChars(maxSegmentChars);
    const segments = longTextMode
      ? splitLongTextForSynthesis(input, segmentCharLimit)
      : [input];

    if (segments.length === 0) {
      pushLog('No valid text segment after preprocessing.');
      return;
    }

    const startedAt = performance.now();
    setBusyAction('synthesize');

    try {
      if (longTextMode && segments.length > 1) {
        if (responseFormat !== 'wav') {
          pushLog('Long text stitching uses WAV internally for stable concatenation.');
        }
        pushLog(
          `Long text mode: split into ${segments.length} segments (max ${segmentCharLimit} chars each).`,
        );

        const decodedSegments: Float32Array[] = [];
        let mergedSampleRate: number | null = null;

        for (let index = 0; index < segments.length; index += 1) {
          const segment = segments[index];
          pushLog(
            `[${index + 1}/${segments.length}] Synthesizing segment (${segment.length} chars)...`,
          );

          const response = await fetch(buildApiUrl(apiBaseUrl, '/v1/audio/speech'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...buildAuthHeaders(apiKey),
            },
            body: JSON.stringify({
              model,
              input: segment,
              voice: voiceId,
              response_format: 'wav',
              speed: clampSpeed(speed),
              stream_format: 'audio',
            }),
          });

          if (!response.ok) {
            throw new Error(await readApiError(response));
          }

          const audioBlob = await response.blob();
          const decoded = await decodeAudioBlob(audioBlob);
          if (mergedSampleRate === null) {
            mergedSampleRate = decoded.sampleRate;
          } else if (mergedSampleRate !== decoded.sampleRate) {
            throw new Error(
              `Sample rate mismatch during long text stitching (${mergedSampleRate} vs ${decoded.sampleRate}).`,
            );
          }
          decodedSegments.push(decoded.samples);
        }

        const mergedSamples = concatFloat32Arrays(decodedSegments);
        const mergedBlob = encodeWav(mergedSamples, mergedSampleRate ?? 24000);
        const objectUrl = URL.createObjectURL(mergedBlob);
        if (resultAudioUrl) {
          URL.revokeObjectURL(resultAudioUrl);
        }

        setResultAudioUrl(objectUrl);
        setResultAudioMime('audio/wav');
        setResultDownloadFormat('wav');
        setResultAudioBytes(mergedBlob.size);
        setLastSynthesisMs(performance.now() - startedAt);
        pushLog(
          `Long text synthesis complete. ${segments.length} segments merged into ${formatBytes(mergedBlob.size)} WAV.`,
        );
        return;
      }

      const response = await fetch(buildApiUrl(apiBaseUrl, '/v1/audio/speech'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(apiKey),
        },
        body: JSON.stringify({
          model,
          input,
          voice: voiceId,
          response_format: responseFormat,
          speed: clampSpeed(speed),
          stream_format: 'audio',
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      const audioBlob = await response.blob();
      const objectUrl = URL.createObjectURL(audioBlob);
      if (resultAudioUrl) {
        URL.revokeObjectURL(resultAudioUrl);
      }

      setResultAudioUrl(objectUrl);
      setResultAudioMime(response.headers.get('Content-Type') ?? 'application/octet-stream');
      setResultDownloadFormat(responseFormat);
      setResultAudioBytes(audioBlob.size);
      setLastSynthesisMs(performance.now() - startedAt);
      pushLog(
        `Synthesis complete for voice ${voiceId}. Output ${formatBytes(audioBlob.size)} (${responseFormat}).`,
      );
    } catch (error) {
      setLastSynthesisMs(null);
      pushLog(`Synthesis failed: ${toErrorMessage(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  const selectedVoiceDetails = voiceDetails[voiceLookupId.trim()];
  const isBusy = busyAction !== null;
  const longTextPreviewSegments = useMemo(
    () => splitLongTextForSynthesis(ttsInput, clampSegmentChars(maxSegmentChars)),
    [ttsInput, maxSegmentChars],
  );

  const statusChip = useMemo(() => {
    if (healthState === 'online') {
      return {
        label: 'Server Online',
        className: 'bg-emerald-500/15 text-emerald-900 ring-1 ring-emerald-500/35',
      };
    }
    if (healthState === 'offline') {
      return {
        label: 'Server Unreachable',
        className: 'bg-rose-500/15 text-rose-900 ring-1 ring-rose-500/35',
      };
    }
    if (healthState === 'checking') {
      return {
        label: 'Checking...',
        className: 'bg-amber-500/15 text-amber-900 ring-1 ring-amber-500/35',
      };
    }
    return {
      label: 'Not Checked',
      className: 'bg-slate-500/15 text-slate-900 ring-1 ring-slate-500/35',
    };
  }, [healthState]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
      <section className="relative overflow-hidden rounded-[2.2rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[0_25px_90px_rgba(21,38,37,0.22)] md:p-10">
        <div className="pointer-events-none absolute -top-20 right-10 h-64 w-64 rounded-full bg-[radial-gradient(circle,var(--accent-soft)_0%,transparent_70%)] opacity-80" />
        <div className="pointer-events-none absolute -bottom-24 left-8 h-64 w-64 rounded-full bg-[radial-gradient(circle,var(--accent)_0%,transparent_72%)] opacity-30" />

        <div className="relative grid gap-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.38em] text-[var(--accent)]">
              VoxCPM.cpp API Studio
            </p>
            <h1 className="mt-3 max-w-4xl text-4xl leading-tight md:text-6xl">OpenAI style voice API frontend</h1>
            <p className="mt-4 max-w-3xl text-base leading-7 text-[var(--ink-soft)] md:text-lg">
              This UI controls your local `voxcpm-server` endpoints: health check, voice registration,
              metadata lookup, deletion, and speech synthesis with instant playback.
            </p>
          </div>

          <div className="rounded-[1.6rem] border border-[var(--line)] bg-white/75 p-5 backdrop-blur-sm">
            <div className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${statusChip.className}`}>
              {statusChip.label}
            </div>
            <p className="mt-3 text-sm text-[var(--ink-soft)]">{healthMessage}</p>
            <p className="mt-2 text-xs text-[var(--ink-soft)]">Busy action: {busyAction ?? 'none'}</p>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="space-y-6">
          <section className="rounded-[1.8rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[0_14px_36px_rgba(19,31,29,0.12)]">
            <h2 className="text-lg font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
              Server Settings
            </h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-2 text-sm font-semibold">
                API Base URL
                <input
                  className="rounded-xl border border-[var(--line)] bg-white px-3 py-2"
                  value={apiBaseUrl}
                  onChange={(event) => setApiBaseUrl(event.target.value)}
                  placeholder="/api or http://127.0.0.1:8080"
                />
              </label>

              <label className="flex flex-col gap-2 text-sm font-semibold">
                Model Name
                <input
                  className="rounded-xl border border-[var(--line)] bg-white px-3 py-2"
                  value={modelName}
                  onChange={(event) => setModelName(event.target.value)}
                  placeholder="voxcpm-1.5"
                />
              </label>
            </div>

            <label className="mt-4 flex flex-col gap-2 text-sm font-semibold">
              API Key (optional with --disable-auth)
              <input
                className="rounded-xl border border-[var(--line)] bg-white px-3 py-2"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Leave empty when auth is disabled"
              />
            </label>

            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                className="rounded-full bg-[var(--ink)] px-5 py-2 text-sm font-semibold text-white transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void handleHealthCheck()}
                disabled={isBusy}
              >
                {busyAction === 'health' ? 'Checking...' : 'Check /healthz'}
              </button>
              <p className="self-center text-xs text-[var(--ink-soft)]">
                `/api` works with dev proxy, avoids browser CORS issues.
              </p>
            </div>
          </section>

          <section className="rounded-[1.8rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[0_14px_36px_rgba(19,31,29,0.12)]">
            <h2 className="text-lg font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
              Voice Registry
            </h2>

            <form className="mt-4 space-y-4" onSubmit={(event) => void handleRegisterVoice(event)}>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="flex flex-col gap-2 text-sm font-semibold">
                  Voice ID
                  <input
                    className="rounded-xl border border-[var(--line)] bg-white px-3 py-2"
                    value={registerVoiceId}
                    onChange={(event) => setRegisterVoiceId(event.target.value)}
                    placeholder="taiyi"
                  />
                </label>

                <label className="flex flex-col gap-2 text-sm font-semibold">
                  Reference Audio
                  <input
                    className="rounded-xl border border-[var(--line)] bg-white px-3 py-2"
                    type="file"
                    accept="audio/*,.wav"
                    onChange={(event) => setRegisterAudioFile(event.target.files?.[0] ?? null)}
                  />
                </label>
              </div>

              <label className="flex flex-col gap-2 text-sm font-semibold">
                Reference Transcript
                <textarea
                  className="min-h-28 rounded-2xl border border-[var(--line)] bg-white px-3 py-2"
                  value={registerPromptText}
                  onChange={(event) => setRegisterPromptText(event.target.value)}
                />
              </label>

              <button
                type="submit"
                className="rounded-full bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isBusy}
              >
                {busyAction === 'register' ? 'Registering...' : 'Register Voice'}
              </button>
            </form>

            <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white/70 p-4">
              <p className="text-sm font-semibold text-[var(--ink)]">Lookup / Delete Voice</p>
              <div className="mt-3 flex flex-wrap items-end gap-3">
                <label className="min-w-[220px] flex-1 text-sm font-semibold">
                  Voice ID
                  <input
                    className="mt-2 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2"
                    value={voiceLookupId}
                    onChange={(event) => setVoiceLookupId(event.target.value)}
                    list="known-voice-ids"
                  />
                </label>
                <button
                  type="button"
                  className="rounded-full border border-[var(--ink)] px-4 py-2 text-sm font-semibold"
                  onClick={() => void handleLookupVoice()}
                  disabled={isBusy}
                >
                  {busyAction === 'lookup' ? 'Loading...' : 'Get Metadata'}
                </button>
                <button
                  type="button"
                  className="rounded-full border border-rose-600 px-4 py-2 text-sm font-semibold text-rose-700"
                  onClick={() => void handleDeleteVoice()}
                  disabled={isBusy}
                >
                  {busyAction === 'delete' ? 'Deleting...' : 'Delete Voice'}
                </button>
              </div>

              <datalist id="known-voice-ids">
                {knownVoiceIds.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>

              {selectedVoiceDetails ? (
                <div className="mt-4 rounded-xl bg-[#f5fbfa] p-4 text-sm text-[var(--ink)]">
                  <p className="font-semibold">Voice: {selectedVoiceDetails.id}</p>
                  <p className="mt-1">Prompt text: {selectedVoiceDetails.prompt_text}</p>
                  <p className="mt-1">Sample rate: {selectedVoiceDetails.sample_rate} Hz</p>
                  <p className="mt-1">Prompt audio length: {selectedVoiceDetails.prompt_audio_length}</p>
                  <p className="mt-1">Feature dim / patch size: {selectedVoiceDetails.feat_dim} / {selectedVoiceDetails.patch_size}</p>
                  <p className="mt-1">Updated at: {selectedVoiceDetails.updated_at}</p>
                </div>
              ) : null}
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section className="rounded-[1.8rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[0_14px_36px_rgba(19,31,29,0.12)]">
            <h2 className="text-lg font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
              Speech Synthesis
            </h2>

            <form className="mt-4 space-y-4" onSubmit={(event) => void handleSynthesize(event)}>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="flex flex-col gap-2 text-sm font-semibold">
                  Voice ID
                  <input
                    className="rounded-xl border border-[var(--line)] bg-white px-3 py-2"
                    value={voiceForTts}
                    onChange={(event) => setVoiceForTts(event.target.value)}
                    list="known-voice-ids"
                    placeholder="taiyi"
                  />
                </label>

                <label className="flex flex-col gap-2 text-sm font-semibold">
                  Response Format
                  <select
                    className="rounded-xl border border-[var(--line)] bg-white px-3 py-2"
                    value={responseFormat}
                    onChange={(event) => setResponseFormat(event.target.value as ResponseFormat)}
                  >
                    <option value="wav">wav</option>
                    <option value="mp3">mp3</option>
                    <option value="flac">flac</option>
                    <option value="pcm">pcm</option>
                  </select>
                </label>
              </div>

              <label className="flex flex-col gap-2 text-sm font-semibold">
                Speed ({clampSpeed(speed).toFixed(2)}x)
                <input
                  type="range"
                  min={0.25}
                  max={4.0}
                  step={0.05}
                  value={clampSpeed(speed)}
                  onChange={(event) => setSpeed(Number(event.target.value))}
                />
              </label>

              <div className="rounded-2xl border border-[var(--line)] bg-white/70 p-4">
                <label className="flex items-center gap-3 text-sm font-semibold">
                  <input
                    type="checkbox"
                    checked={longTextMode}
                    onChange={(event) => setLongTextMode(event.target.checked)}
                  />
                  Enable long text mode (split and stitch)
                </label>

                {longTextMode ? (
                  <div className="mt-3 grid gap-3 md:grid-cols-[220px_1fr] md:items-end">
                    <label className="flex flex-col gap-2 text-sm font-semibold">
                      Max chars per segment
                      <input
                        className="rounded-xl border border-[var(--line)] bg-white px-3 py-2"
                        type="number"
                        min={60}
                        max={600}
                        value={maxSegmentChars}
                        onChange={(event) =>
                          setMaxSegmentChars(clampSegmentChars(Number(event.target.value)))
                        }
                      />
                    </label>
                    <p className="text-sm text-[var(--ink-soft)]">
                      The guide recommends splitting long text to reduce buzzing, runaway generation, and
                      memory pressure. Estimated segments: {longTextPreviewSegments.length || 0}
                    </p>
                  </div>
                ) : null}
              </div>

              <label className="flex flex-col gap-2 text-sm font-semibold">
                Input Text
                <textarea
                  className="min-h-36 rounded-2xl border border-[var(--line)] bg-white px-3 py-2"
                  value={ttsInput}
                  onChange={(event) => setTtsInput(event.target.value)}
                />
              </label>

              <button
                type="submit"
                className="rounded-full bg-[var(--ink)] px-5 py-2 text-sm font-semibold text-white transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isBusy}
              >
                {busyAction === 'synthesize' ? 'Synthesizing...' : 'POST /v1/audio/speech'}
              </button>
            </form>
          </section>

          <section className="rounded-[1.8rem] border border-[var(--line)] bg-[var(--panel)] p-6 shadow-[0_14px_36px_rgba(19,31,29,0.12)]">
            <h2 className="text-lg font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
              Output
            </h2>

            {resultAudioUrl ? (
              <div className="mt-4 space-y-3">
                <audio controls className="w-full" src={resultAudioUrl} />
                <p className="text-sm text-[var(--ink-soft)]">
                  {resultAudioBytes !== null ? formatBytes(resultAudioBytes) : '--'} | {resultAudioMime} | {formatElapsed(lastSynthesisMs)}
                </p>
                <a
                  href={resultAudioUrl}
                  download={createDownloadName(voiceForTts, resultDownloadFormat)}
                  className="inline-flex rounded-full border border-[var(--ink)] px-4 py-2 text-sm font-semibold"
                >
                  Download Audio
                </a>
              </div>
            ) : (
              <p className="mt-4 text-sm text-[var(--ink-soft)]">
                No audio yet. Run synthesis to preview and download the generated file.
              </p>
            )}
          </section>

          <section className="rounded-[1.8rem] border border-[#1a2c2b] bg-[#0f1b1b] p-6 text-[#dbebe9] shadow-[0_20px_50px_rgba(8,12,12,0.35)]">
            <h2 className="text-lg font-semibold uppercase tracking-[0.18em] text-[#88d8cd]">Activity Log</h2>
            <div className="mt-4 max-h-72 space-y-2 overflow-auto text-sm leading-6">
              {logs.map((entry, index) => (
                <p key={`${entry}-${index}`}>{entry}</p>
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
