import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { GoogleAIFileManager } from '@google/generative-ai/server';

let currentController: AbortController | null = null;

const ffmpegPath = (ffmpegStatic as unknown as string) || '';
const LONG_AUDIO_SPLIT_THRESHOLD_SECONDS = 3600;
const TARGET_CHUNK_SECONDS = 30 * 60;
const MAX_CHUNK_SECONDS = 35 * 60;
const CHUNK_OVERLAP_SECONDS = 1.5;
const SILENCE_SNAP_WINDOW_SECONDS = 90;
const SILENCE_DETECT_MIN_DURATION_SECONDS = 0.6;
const SILENCE_DETECT_NOISE_LEVEL = '-35dB';
const MIN_BOUNDARY_GAP_SECONDS = 60;
const MIN_OVERLAP_LINES_FOR_DEDUPE = 2;
const MAX_OVERLAP_LINES_FOR_DEDUPE = 16;
const SRT_DUPLICATE_WINDOW_MS = 1500;
const MAX_MISTRAL_ERROR_SNIPPET = 500;
const MISTRAL_API_BASE = 'https://api.mistral.ai/v1';

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg'
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  const bin = ffmpegPath;
  if (!bin) throw new Error('ffmpeg binary not found (ffmpeg-static)');

  return new Promise((resolve, reject) => {
    let settled = false;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const onAbort = () => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      done(new DOMException('Aborted', 'AbortError'));
    };

    const proc = execFile(bin, args, { windowsHide: true }, (err) => {
      if (err) return done(err);
      done();
    });

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function runFfmpegCapture(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const bin = ffmpegPath;
  if (!bin) throw new Error('ffmpeg binary not found (ffmpeg-static)');

  return new Promise((resolve, reject) => {
    let settled = false;

    const done = (err?: Error, stdout = '', stderr = '') => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) {
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    };

    const onAbort = () => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      done(new DOMException('Aborted', 'AbortError'));
    };

    const proc = execFile(
      bin,
      args,
      {
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (err) return done(err, String(stdout || ''), String(stderr || ''));
        done(undefined, String(stdout || ''), String(stderr || ''));
      }
    );

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function probeDurationSeconds(filePath: string): Promise<number> {
  const bin = ffmpegPath;
  if (!bin) return 0;
  return new Promise((resolve) => {
    const proc = execFile(bin, ['-i', filePath], { windowsHide: true }, (_err, _stdout, stderr) => {
      const m = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(stderr || '');
      if (!m) return resolve(0);
      const [h, mm, ss, ms] = m.slice(1).map(Number);
      const frac = Number(`0.${ms}`) || 0;
      resolve(h * 3600 + mm * 60 + ss + frac);
    });
    proc.on('error', () => resolve(0));
  });
}

function stripCodeFence(s: string): string {
  let out = s.trim();
  out = out.replace(/^```(?:\w+)?\s*/g, '');
  out = out.replace(/\s*```$/g, '');
  return out.trim();
}

function sanitizeChunkText(text: string): string {
  const noFence = stripCodeFence(text || '');
  return noFence.replace(/\[END\]/gi, '').trim();
}

function tryParseSpeakerJson(raw: string): Array<{ speaker?: string; transcription?: string }> | null {
  const cleaned = stripCodeFence(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'object' && 'transcription' in item)) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function formatSpeakerTranscript(entries: Array<{ speaker?: string; transcription?: string }>): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const speaker = entry.speaker || 'Unknown';
    const text = (entry.transcription || '').replace(/\s+/g, ' ').trim();
    lines.push(`${speaker}: ${text}`);
    lines.push('');
  }
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function mergeInterviewEntries(
  groups: Array<Array<{ speaker?: string; transcription?: string }>>
): Array<{ speaker?: string; transcription?: string }> {
  const merged: Array<{ speaker?: string; transcription?: string }> = [];
  for (const group of groups) {
    for (const entry of group) {
      const speaker = (entry.speaker || 'Unknown').trim() || 'Unknown';
      const transcription = (entry.transcription || '').replace(/\s+/g, ' ').trim();
      if (!transcription) continue;

      const prev = merged[merged.length - 1];
      if (
        prev &&
        (prev.speaker || 'Unknown').trim().toLowerCase() === speaker.toLowerCase() &&
        normalizeTextForComparison(prev.transcription || '') === normalizeTextForComparison(transcription)
      ) {
        continue;
      }

      merged.push({ speaker, transcription });
    }
  }
  return merged;
}

function normalizeTextForComparison(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function splitMeaningfulLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function parseBracketClockToSeconds(inner: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(inner.trim());
  if (!m) return null;
  const hasHours = typeof m[3] === 'string';
  const hours = hasHours ? Number(m[1]) : 0;
  const minutes = hasHours ? Number(m[2]) : Number(m[1]);
  const seconds = hasHours ? Number(m[3]) : Number(m[2]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function formatBracketClock(totalSeconds: number, includeHours: boolean): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(safe / 3600);
  const rem = safe % 3600;
  const m = Math.floor(rem / 60);
  const s = rem % 60;
  if (includeHours || h > 0) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function shiftBracketTimestamps(text: string, offsetSeconds: number): string {
  if (!offsetSeconds) return text;

  return text.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (_m, inner: string) => {
    const parsed = parseBracketClockToSeconds(inner);
    if (parsed === null) return `[${inner}]`;
    const shifted = parsed + offsetSeconds;
    const includeHours = inner.split(':').length === 3 || shifted >= 3600;
    return `[${formatBracketClock(shifted, includeHours)}]`;
  });
}

type SrtCue = {
  startMs: number;
  endMs: number;
  text: string;
};

type AudioChunk = {
  audioPath: string;
  startOffsetSeconds: number;
  durationSeconds: number;
};

type PlannedChunkRange = {
  startSeconds: number;
  durationSeconds: number;
};

type SilenceRange = {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
};

type MistralAudioSegment = {
  startSeconds: number;
  endSeconds: number;
  text: string;
  speaker?: string;
};

function parseSrtTimestamp(raw: string): number | null {
  const clean = raw.trim();
  const m = /^(?:(\d{1,2}):)?(\d{2}):(\d{2})(?:[,.](\d{1,3}))?$/.exec(clean);
  if (!m) return null;

  const hours = Number(m[1] || '0');
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const msRaw = m[4] || '0';
  const millis = Number(msRaw.padEnd(3, '0').slice(0, 3));

  if (![hours, minutes, seconds, millis].every(Number.isFinite)) return null;
  return hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + millis;
}

function formatSrtTimestamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const h = Math.floor(safe / 3_600_000);
  const remAfterHours = safe % 3_600_000;
  const m = Math.floor(remAfterHours / 60_000);
  const remAfterMinutes = remAfterHours % 60_000;
  const s = Math.floor(remAfterMinutes / 1_000);
  const millis = remAfterMinutes % 1_000;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${millis.toString().padStart(3, '0')}`;
}

function parseSrtCues(rawText: string): SrtCue[] {
  const normalized = stripCodeFence(rawText || '').replace(/\r/g, '').trim();
  if (!normalized) return [];

  const blocks = normalized.split(/\n{2,}/);
  const cues: SrtCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').map(line => line.trimEnd()).filter(line => line.trim().length > 0);
    if (lines.length < 2) continue;

    let idx = 0;
    if (/^\d+$/.test(lines[0].trim())) idx = 1;
    if (idx >= lines.length) continue;

    const timeLine = lines[idx].trim();
    const timeMatch = /^(.+?)\s*-->\s*(.+)$/.exec(timeLine);
    if (!timeMatch) continue;

    const startMs = parseSrtTimestamp(timeMatch[1]);
    const endMs = parseSrtTimestamp(timeMatch[2]);
    if (startMs === null || endMs === null) continue;

    const text = lines.slice(idx + 1).map(line => line.trim()).filter(Boolean).join('\n');
    if (!text) continue;

    cues.push({
      startMs,
      endMs: Math.max(endMs, startMs + 1),
      text
    });
  }

  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}

function shiftSrtCues(cues: SrtCue[], offsetSeconds: number): SrtCue[] {
  if (!offsetSeconds) return cues.map(cue => ({ ...cue }));
  const offsetMs = Math.round(offsetSeconds * 1000);
  return cues.map(cue => ({
    startMs: cue.startMs + offsetMs,
    endMs: cue.endMs + offsetMs,
    text: cue.text
  }));
}

function mergeSrtCueLists(chunkCueLists: SrtCue[][]): SrtCue[] {
  const merged: SrtCue[] = [];

  for (const cues of chunkCueLists) {
    for (const cue of cues) {
      const current: SrtCue = { ...cue };
      const currentNorm = normalizeTextForComparison(current.text);
      if (!currentNorm) continue;

      if (!merged.length) {
        merged.push(current);
        continue;
      }

      const prev = merged[merged.length - 1];
      const prevNorm = normalizeTextForComparison(prev.text);

      if (currentNorm === prevNorm && current.startMs <= prev.endMs + SRT_DUPLICATE_WINDOW_MS) {
        prev.endMs = Math.max(prev.endMs, current.endMs);
        continue;
      }

      if (current.startMs <= prev.endMs) {
        current.startMs = prev.endMs + 1;
        if (current.endMs <= current.startMs) {
          current.endMs = current.startMs + 1;
        }
      }

      merged.push(current);
    }
  }

  return merged;
}

function serializeSrtCues(cues: SrtCue[]): string {
  if (!cues.length) return '';
  return `${cues.map((cue, index) => {
    return `${index + 1}\n${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}\n${cue.text.trim()}`;
  }).join('\n\n')}\n`;
}

function formatTranscriptTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const rem = totalSeconds % 3600;
  const m = Math.floor(rem / 60);
  const s = rem % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function srtCuesToTranscript(cues: SrtCue[]): string {
  const lines: string[] = [];
  let previous = '';
  for (const cue of cues) {
    const text = cue.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const line = `[${formatTranscriptTimestamp(cue.startMs)}] ${text}`;
    const normalized = normalizeTextForComparison(line);
    if (normalized === previous) continue;
    lines.push(line);
    previous = normalized;
  }
  return lines.join('\n');
}

function srtToTranscript(srtText: string): string {
  const cues = parseSrtCues(srtText);
  if (cues.length) return srtCuesToTranscript(cues);

  const blocks = srtText.trim().split(/\n{2,}/);
  const lines: string[] = [];
  for (const block of blocks) {
    const parts = block.split(/\r?\n/).map(part => part.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const lineIndex = /^\d+$/.test(parts[0]) ? 1 : 0;
    const timeLine = parts[lineIndex] || '';
    if (!timeLine.includes('-->')) continue;
    const start = timeLine.split('-->')[0]?.trim() || '';
    const startMs = parseSrtTimestamp(start);
    const text = parts.slice(lineIndex + 1).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const stamp = startMs === null ? '00:00:00' : formatTranscriptTimestamp(startMs);
    lines.push(`[${stamp}] ${text}`);
  }
  return lines.join('\n');
}

function normalizeSrtText(rawText: string): { srtText: string; cues: SrtCue[] } {
  const cues = parseSrtCues(rawText);
  if (cues.length) {
    return { srtText: serializeSrtCues(cues), cues };
  }
  const fallback = stripCodeFence(rawText || '').trim();
  return { srtText: fallback, cues: [] };
}

function mergeTextChunks(chunkTexts: string[]): string {
  const mergedLines: string[] = [];

  for (const chunkText of chunkTexts) {
    const lines = splitMeaningfulLines(chunkText);
    if (!lines.length) continue;

    let skipCount = 0;
    if (mergedLines.length) {
      const maxOverlap = Math.min(MAX_OVERLAP_LINES_FOR_DEDUPE, mergedLines.length, lines.length);
      for (let overlap = maxOverlap; overlap >= MIN_OVERLAP_LINES_FOR_DEDUPE; overlap -= 1) {
        let matches = true;
        for (let i = 0; i < overlap; i += 1) {
          const left = normalizeTextForComparison(mergedLines[mergedLines.length - overlap + i]);
          const right = normalizeTextForComparison(lines[i]);
          if (left !== right) {
            matches = false;
            break;
          }
        }
        if (matches) {
          skipCount = overlap;
          break;
        }
      }

      while (
        skipCount < lines.length &&
        normalizeTextForComparison(lines[skipCount]) === normalizeTextForComparison(mergedLines[mergedLines.length - 1])
      ) {
        skipCount += 1;
      }
    }

    for (let i = skipCount; i < lines.length; i += 1) {
      mergedLines.push(lines[i]);
    }
  }

  return mergedLines.join('\n');
}

function sanitizeMistralErrorText(errText: string): string {
  if (!errText) return '';
  const trimmed = errText.trim();
  if (!trimmed) return '';
  const scrubbed = trimmed.replace(/[A-Za-z0-9+/=]{200,}/g, '[base64 omitted]');
  if (scrubbed.length <= MAX_MISTRAL_ERROR_SNIPPET) return scrubbed;
  return `${scrubbed.slice(0, MAX_MISTRAL_ERROR_SNIPPET)}…`;
}

async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

async function uploadAudioFileToMistral(filePath: string, apiKey: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const data = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([data]), path.basename(filePath));
  form.append('purpose', 'audio');

  const resp = await fetch(`${MISTRAL_API_BASE}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal
  });

  if (!resp.ok) {
    const errText = sanitizeMistralErrorText(await resp.text().catch(() => ''));
    const err: any = new Error(`Mistral audio file upload failed: ${resp.status} ${resp.statusText} ${errText}`);
    err.status = resp.status;
    throw err;
  }

  const json = await resp.json();
  const id = typeof json?.id === 'string' ? json.id : '';
  if (!id) {
    throw new Error('Mistral audio file upload missing id in response');
  }
  return id;
}

async function getMistralSignedUrl(fileId: string, apiKey: string, signal: AbortSignal): Promise<string> {
  const maxRetries = 3;
  const baseDelayMs = 800;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const resp = await fetch(`${MISTRAL_API_BASE}/files/${encodeURIComponent(fileId)}/url`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal
    });

    if (resp.ok) {
      const json = await resp.json();
      const url = typeof json?.url === 'string' ? json.url : '';
      if (!url) {
        throw new Error('Mistral signed URL response missing url');
      }
      return url;
    }

    if (resp.status === 404 && attempt < maxRetries - 1) {
      await sleepWithSignal(baseDelayMs * Math.pow(2, attempt), signal);
      continue;
    }

    const errText = sanitizeMistralErrorText(await resp.text().catch(() => ''));
    const err: any = new Error(`Mistral signed URL failed: ${resp.status} ${resp.statusText} ${errText}`);
    err.status = resp.status;
    throw err;
  }

  throw new Error(`Failed to retrieve Mistral signed URL for file ${fileId}`);
}

function parseSecondsLike(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) return asNumber;

  const asSrtMs = parseSrtTimestamp(trimmed);
  if (asSrtMs !== null) return asSrtMs / 1000;

  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(trimmed);
  if (!clock) return null;
  const hasHours = typeof clock[3] === 'string';
  const hours = hasHours ? Number(clock[1]) : 0;
  const minutes = hasHours ? Number(clock[2]) : Number(clock[1]);
  const seconds = hasHours ? Number(clock[3]) : Number(clock[2]);
  const fraction = hasHours && clock[4] ? Number(`0.${clock[4]}`) : 0;
  if (![hours, minutes, seconds, fraction].every(Number.isFinite)) return null;
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

function extractMistralSegments(payload: any): MistralAudioSegment[] {
  const candidates: any[] = [
    payload?.segments,
    payload?.chunks,
    payload?.timestamps?.segments,
    payload?.result?.segments,
    payload?.data?.segments
  ];
  const rawSegments = candidates.find(item => Array.isArray(item));
  if (!Array.isArray(rawSegments)) return [];

  const segments: MistralAudioSegment[] = [];
  let fallbackStart = 0;

  for (const seg of rawSegments) {
    const startRaw =
      seg?.start ??
      seg?.start_time ??
      seg?.startTime ??
      seg?.from ??
      seg?.timestamp?.start ??
      seg?.time?.start;
    const endRaw =
      seg?.end ??
      seg?.end_time ??
      seg?.endTime ??
      seg?.to ??
      seg?.timestamp?.end ??
      seg?.time?.end;
    const durationRaw = seg?.duration ?? seg?.timestamp?.duration ?? seg?.time?.duration;
    const textRaw = seg?.text ?? seg?.transcript ?? seg?.transcription ?? seg?.utterance ?? '';
    const speakerRaw = seg?.speaker ?? seg?.speaker_id ?? seg?.speakerId ?? seg?.spk ?? '';

    const text = typeof textRaw === 'string' ? textRaw.trim() : '';
    if (!text) continue;

    let startSeconds = parseSecondsLike(startRaw);
    if (startSeconds === null) startSeconds = fallbackStart;
    let endSeconds = parseSecondsLike(endRaw);
    if (endSeconds === null) {
      const duration = parseSecondsLike(durationRaw);
      endSeconds = duration !== null ? startSeconds + Math.max(duration, 0.2) : startSeconds + 1;
    }
    if (endSeconds <= startSeconds) endSeconds = startSeconds + 0.2;

    const speaker = typeof speakerRaw === 'string' && speakerRaw.trim() ? speakerRaw.trim() : undefined;
    segments.push({ startSeconds, endSeconds, text, speaker });
    fallbackStart = endSeconds;
  }

  segments.sort((a, b) => a.startSeconds - b.startSeconds);
  return segments;
}

function extractMistralTranscriptionText(payload: any): string {
  const directTextCandidates = [
    payload?.text,
    payload?.transcript,
    payload?.transcription,
    payload?.result?.text,
    payload?.data?.text
  ];
  for (const candidate of directTextCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  const segments = extractMistralSegments(payload);
  if (segments.length) {
    return segments.map(seg => seg.text).join('\n');
  }
  return '';
}

function mistralSegmentsToSrtCues(segments: MistralAudioSegment[]): SrtCue[] {
  return segments
    .map(seg => {
      const startMs = Math.max(0, Math.round(seg.startSeconds * 1000));
      const endMs = Math.max(startMs + 1, Math.round(seg.endSeconds * 1000));
      const text = seg.text.trim();
      return { startMs, endMs, text };
    })
    .filter(cue => Boolean(cue.text));
}

function mistralSegmentsToTranscriptLines(segments: MistralAudioSegment[]): string[] {
  const lines: string[] = [];
  let lastNormalized = '';
  for (const seg of segments) {
    const text = seg.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const stamp = formatTranscriptTimestamp(Math.max(0, Math.round(seg.startSeconds * 1000)));
    const line = `[${stamp}] ${text}`;
    const normalized = normalizeTextForComparison(line);
    if (normalized === lastNormalized) continue;
    lines.push(line);
    lastNormalized = normalized;
  }
  return lines;
}

function mistralSegmentsToInterviewEntries(
  segments: MistralAudioSegment[]
): Array<{ speaker?: string; transcription?: string }> {
  const entries: Array<{ speaker?: string; transcription?: string }> = [];
  for (const seg of segments) {
    const text = seg.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const speaker = seg.speaker && seg.speaker.trim() ? seg.speaker.trim() : 'Speaker';
    const prev = entries[entries.length - 1];
    if (prev && (prev.speaker || '').toLowerCase() === speaker.toLowerCase()) {
      prev.transcription = `${(prev.transcription || '').trim()} ${text}`.trim();
      continue;
    }
    entries.push({ speaker, transcription: text });
  }
  return entries;
}

type MistralTranscribeResult = {
  text: string;
  segments: MistralAudioSegment[];
};

async function uploadAndTranscribeMistral(
  filePath: string,
  modelName: string,
  apiKey: string,
  signal: AbortSignal,
  opts: { subtitles: boolean; interviewMode: boolean }
): Promise<MistralTranscribeResult> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const data = await fs.promises.readFile(filePath);
  const fileBlob = new Blob([data]);
  const baseName = path.basename(filePath);

  const sendRequest = async (
    timestampEncoding: 'flat' | 'json-array'
  ): Promise<{ ok: boolean; status: number; statusText: string; payload?: any; errText?: string }> => {
    const form = new FormData();
    form.append('model', modelName);
    form.append('file', fileBlob, baseName);

    if (opts.subtitles || opts.interviewMode) {
      if (timestampEncoding === 'json-array') {
        form.append('timestamp_granularities', JSON.stringify(['segment']));
      } else {
        form.append('timestamp_granularities', 'segment');
      }
    }
    if (opts.interviewMode) {
      form.append('diarize', 'true');
    }

    const resp = await fetch(`${MISTRAL_API_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form,
      signal
    });

    if (!resp.ok) {
      const errText = sanitizeMistralErrorText(await resp.text().catch(() => ''));
      return {
        ok: false,
        status: resp.status,
        statusText: resp.statusText,
        errText
      };
    }

    const payload = await resp.json();
    return {
      ok: true,
      status: resp.status,
      statusText: resp.statusText,
      payload
    };
  };

  let result = await sendRequest('flat');
  if (
    !result.ok &&
    (opts.subtitles || opts.interviewMode) &&
    result.status === 422
  ) {
    const retry = await sendRequest('json-array');
    if (retry.ok) {
      result = retry;
    } else {
      const err: any = new Error(
        `Mistral transcription failed: ${retry.status} ${retry.statusText} ${retry.errText || ''}`
      );
      err.status = retry.status;
      throw err;
    }
  }

  if (!result.ok) {
    const err: any = new Error(
      `Mistral transcription failed: ${result.status} ${result.statusText} ${result.errText || ''}`
    );
    err.status = result.status;
    throw err;
  }

  const payload = result.payload;
  const segments = extractMistralSegments(payload);
  const text = extractMistralTranscriptionText(payload);
  if (!text && !segments.length) {
    throw new Error('Mistral transcription returned no text.');
  }
  return { text, segments };
}

function clampNumber(value: number, min: number, max: number): number {
  if (min > max) return value;
  return Math.min(Math.max(value, min), max);
}

function parseSilenceRangesFromFfmpegLog(stderrLog: string): SilenceRange[] {
  const ranges: SilenceRange[] = [];
  let pendingStart: number | null = null;

  for (const rawLine of stderrLog.split(/\r?\n/)) {
    const line = rawLine.trim();

    const startMatch = /silence_start:\s*([0-9.]+)/.exec(line);
    if (startMatch) {
      const startSeconds = Number(startMatch[1]);
      if (Number.isFinite(startSeconds)) {
        pendingStart = startSeconds;
      }
    }

    const endMatch = /silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/.exec(line);
    if (!endMatch) continue;

    const endSeconds = Number(endMatch[1]);
    const durationSeconds = Number(endMatch[2]);
    if (!Number.isFinite(endSeconds)) continue;

    const inferredStart = pendingStart !== null
      ? pendingStart
      : (Number.isFinite(durationSeconds) ? Math.max(0, endSeconds - Math.max(0, durationSeconds)) : endSeconds);
    const normalizedStart = Math.max(0, inferredStart);
    const normalizedEnd = Math.max(normalizedStart + 0.001, endSeconds);

    ranges.push({
      startSeconds: normalizedStart,
      endSeconds: normalizedEnd,
      durationSeconds: normalizedEnd - normalizedStart
    });

    pendingStart = null;
  }

  if (!ranges.length) return [];
  ranges.sort((a, b) => a.startSeconds - b.startSeconds);

  const merged: SilenceRange[] = [{ ...ranges[0] }];
  for (let i = 1; i < ranges.length; i += 1) {
    const prev = merged[merged.length - 1];
    const current = ranges[i];
    if (current.startSeconds <= prev.endSeconds + 0.05) {
      prev.endSeconds = Math.max(prev.endSeconds, current.endSeconds);
      prev.durationSeconds = prev.endSeconds - prev.startSeconds;
      continue;
    }
    merged.push({ ...current });
  }

  return merged;
}

async function detectSilenceRanges(
  inputPath: string,
  signal: AbortSignal,
  logger: (msg: string) => Promise<void> | void
): Promise<SilenceRange[]> {
  const args = [
    '-hide_banner',
    '-i',
    inputPath,
    '-af',
    `silencedetect=n=${SILENCE_DETECT_NOISE_LEVEL}:d=${SILENCE_DETECT_MIN_DURATION_SECONDS}`,
    '-f',
    'null',
    '-'
  ];

  try {
    const { stderr } = await runFfmpegCapture(args, signal);
    const ranges = parseSilenceRangesFromFfmpegLog(stderr || '');
    await logger(
      `[INFO] Silence analysis found ${ranges.length} range(s) (threshold ${SILENCE_DETECT_NOISE_LEVEL}, min ${SILENCE_DETECT_MIN_DURATION_SECONDS}s).`
    );
    return ranges;
  } catch (err: any) {
    if (err?.name === 'AbortError' || signal.aborted) throw err;
    const detail = err?.message || 'unknown error';
    await logger(`[WARN] Silence analysis failed (${detail}); using time-based chunk boundaries.`);
    return [];
  }
}

function planBalancedChunkRanges(durationSeconds: number): PlannedChunkRange[] {
  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : TARGET_CHUNK_SECONDS;
  const minChunksByMax = Math.max(1, Math.ceil(safeDuration / MAX_CHUNK_SECONDS));
  let chunkCount = Math.max(1, Math.round(safeDuration / TARGET_CHUNK_SECONDS), minChunksByMax);

  if (safeDuration > LONG_AUDIO_SPLIT_THRESHOLD_SECONDS) {
    chunkCount = Math.max(2, chunkCount);
  }

  while (safeDuration / chunkCount > MAX_CHUNK_SECONDS) {
    chunkCount += 1;
  }

  const ranges: PlannedChunkRange[] = [];
  let startSeconds = 0;
  for (let i = 0; i < chunkCount; i += 1) {
    const endSeconds = i === chunkCount - 1 ? safeDuration : (safeDuration * (i + 1)) / chunkCount;
    const duration = Math.max(0.001, endSeconds - startSeconds);
    ranges.push({ startSeconds, durationSeconds: duration });
    startSeconds = endSeconds;
  }

  return ranges;
}

function chunkRangesToBoundaries(ranges: PlannedChunkRange[]): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i < ranges.length - 1; i += 1) {
    boundaries.push(ranges[i].startSeconds + ranges[i].durationSeconds);
  }
  return boundaries;
}

function boundariesToChunkRanges(boundaries: number[], totalDurationSeconds: number): PlannedChunkRange[] {
  const ranges: PlannedChunkRange[] = [];
  let startSeconds = 0;

  for (const boundary of boundaries) {
    const safeBoundary = Math.max(startSeconds + 0.001, boundary);
    ranges.push({
      startSeconds,
      durationSeconds: safeBoundary - startSeconds
    });
    startSeconds = safeBoundary;
  }

  const finalEnd = Math.max(startSeconds + 0.001, totalDurationSeconds);
  ranges.push({
    startSeconds,
    durationSeconds: finalEnd - startSeconds
  });

  return ranges;
}

function snapBoundariesToSilence(
  targetBoundaries: number[],
  silenceRanges: SilenceRange[],
  totalDurationSeconds: number
): { boundaries: number[]; snappedCount: number } {
  if (!targetBoundaries.length || !silenceRanges.length) {
    return { boundaries: [...targetBoundaries], snappedCount: 0 };
  }

  const boundaries: number[] = [];
  let snappedCount = 0;

  for (let i = 0; i < targetBoundaries.length; i += 1) {
    const target = targetBoundaries[i];
    const prevBoundary = i === 0 ? 0 : boundaries[i - 1];
    const remainingBoundaries = targetBoundaries.length - i - 1;

    let minBoundary = prevBoundary + MIN_BOUNDARY_GAP_SECONDS;
    let maxBoundary = totalDurationSeconds - (remainingBoundaries + 1) * MIN_BOUNDARY_GAP_SECONDS;

    if (minBoundary > maxBoundary) {
      minBoundary = prevBoundary + 1;
      maxBoundary = totalDurationSeconds - (remainingBoundaries + 1);
    }
    if (minBoundary > maxBoundary) {
      minBoundary = prevBoundary + 0.001;
      maxBoundary = Math.max(minBoundary, totalDurationSeconds - 0.001);
    }

    const clampedTarget = clampNumber(target, minBoundary, maxBoundary);
    let bestCandidate = clampedTarget;
    let bestDistance = Number.POSITIVE_INFINITY;
    const windowStart = clampedTarget - SILENCE_SNAP_WINDOW_SECONDS;
    const windowEnd = clampedTarget + SILENCE_SNAP_WINDOW_SECONDS;

    for (const silence of silenceRanges) {
      if (silence.endSeconds < windowStart || silence.startSeconds > windowEnd) continue;

      const localMin = Math.max(minBoundary, silence.startSeconds);
      const localMax = Math.min(maxBoundary, silence.endSeconds);
      if (localMax < localMin) continue;

      const candidate = clampNumber(clampedTarget, localMin, localMax);
      const distance = Math.abs(candidate - clampedTarget);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestCandidate = candidate;
        if (distance === 0) break;
      }
    }

    if (bestDistance <= SILENCE_SNAP_WINDOW_SECONDS) {
      snappedCount += 1;
    }
    boundaries.push(bestCandidate);
  }

  return { boundaries, snappedCount };
}

function applyChunkOverlap(ranges: PlannedChunkRange[], totalDurationSeconds: number): PlannedChunkRange[] {
  if (ranges.length <= 1 || CHUNK_OVERLAP_SECONDS <= 0) {
    return ranges.map(range => ({ ...range }));
  }

  const halfOverlap = CHUNK_OVERLAP_SECONDS / 2;
  return ranges.map((range, index) => {
    const logicalStart = range.startSeconds;
    const logicalEnd = logicalStart + range.durationSeconds;
    const startSeconds = index === 0 ? logicalStart : Math.max(0, logicalStart - halfOverlap);
    const endSeconds = index === ranges.length - 1 ? logicalEnd : Math.min(totalDurationSeconds, logicalEnd + halfOverlap);
    const durationSeconds = Math.max(0.001, endSeconds - startSeconds);
    return { startSeconds, durationSeconds };
  });
}

async function createAudioChunks(
  inputPath: string,
  outputDir: string,
  base: string,
  totalDurationSeconds: number,
  signal: AbortSignal,
  logger: (msg: string) => Promise<void> | void
): Promise<AudioChunk[]> {
  const baseRanges = planBalancedChunkRanges(totalDurationSeconds);
  const targetBoundaries = chunkRangesToBoundaries(baseRanges);
  let logicalRanges = baseRanges;

  if (targetBoundaries.length) {
    const silenceRanges = await detectSilenceRanges(inputPath, signal, logger);
    if (silenceRanges.length) {
      const snapped = snapBoundariesToSilence(targetBoundaries, silenceRanges, totalDurationSeconds);
      logicalRanges = boundariesToChunkRanges(snapped.boundaries, totalDurationSeconds);
      const noun = targetBoundaries.length === 1 ? 'boundary' : 'boundaries';
      await logger(
        `[INFO] Boundary snapping aligned ${snapped.snappedCount}/${targetBoundaries.length} ${noun} to silence (window ±${SILENCE_SNAP_WINDOW_SECONDS}s).`
      );
    } else {
      await logger('[INFO] Boundary snapping skipped: no usable silence ranges.');
    }
  }

  const ranges = applyChunkOverlap(logicalRanges, totalDurationSeconds);
  const avgMinutes = totalDurationSeconds / 60 / Math.max(1, logicalRanges.length);
  await logger(
    `[INFO] Splitting audio into ${ranges.length} chunk(s) (~${avgMinutes.toFixed(1)} min each, target ${Math.round(TARGET_CHUNK_SECONDS / 60)} min).`
  );
  if (ranges.length > 1 && CHUNK_OVERLAP_SECONDS > 0) {
    await logger(`[INFO] Applying ${CHUNK_OVERLAP_SECONDS.toFixed(1)}s overlap between adjacent chunks.`);
  }

  const splitId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const chunks: AudioChunk[] = [];

  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i];
    const fileName = `${base}__chunk_${splitId}_${String(i).padStart(3, '0')}.mp3`;
    const audioPath = path.join(outputDir, fileName);
    await runFfmpeg(
      [
        '-y',
        '-i',
        inputPath,
        '-ss',
        range.startSeconds.toFixed(3),
        '-t',
        range.durationSeconds.toFixed(3),
        '-c',
        'copy',
        audioPath
      ],
      signal
    );

    const measuredDuration = await probeDurationSeconds(audioPath);
    const durationSeconds = measuredDuration > 0 ? measuredDuration : range.durationSeconds;
    chunks.push({
      audioPath,
      startOffsetSeconds: range.startSeconds,
      durationSeconds
    });
  }

  await logger(`[INFO] Created ${chunks.length} chunk(s) for transcription.`);
  return chunks;
}

async function cleanupAudioChunks(chunks: AudioChunk[]): Promise<void> {
  await Promise.all(
    chunks.map(async chunk => {
      await fs.promises.rm(chunk.audioPath, { force: true }).catch(() => {});
    })
  );
}

function extractTextFromResponse(json: any): string {
  try {
    const cand = json?.candidates?.[0];
    const parts = cand?.content?.parts;
    if (Array.isArray(parts)) {
      const texts = parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean);
      if (texts.length) return texts.join('\n');
    }
  } catch {}
  try {
    if (typeof json?.text === 'string') return json.text;
  } catch {}
  return '';
}

function formatPrompt(rawPrompt: string, interview: boolean, subtitles: boolean): string {
  // Prefer the prompt provided by the caller (UI) for both default and interview modes.
  let prompt = rawPrompt;
  if (subtitles) {
    prompt = `${prompt}\n\nPlease emit a valid SRT subtitle file.`;
  }
  return prompt;
}

async function uploadAndTranscribe(
  filePath: string,
  prompt: string,
  modelName: string,
  apiKey: string,
  mimeType: string,
  signal: AbortSignal
): Promise<string> {
  const fileManager = new GoogleAIFileManager(apiKey);

  const uploadResp = await fileManager.uploadFile(filePath, {
    mimeType,
    displayName: path.basename(filePath)
  });

  // Wait for the uploaded file to be marked ACTIVE
  const uploadedName =
    uploadResp?.file?.name ||
    (uploadResp as any)?.file?.id ||
    (uploadResp as any)?.name;
  if (!uploadedName) throw new Error('Failed to upload audio file');

  let fileUri = uploadResp?.file?.uri || (uploadResp as any)?.uri;
  let fileState = (uploadResp as any)?.file?.state || (uploadResp as any)?.state;
  let attempts = 0;
  while (!fileUri || (fileState && fileState !== 'ACTIVE')) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    attempts += 1;
    if (attempts > 15) throw new Error('Timed out waiting for uploaded audio URI');
    await sleep(1000);
    const next = await fileManager.getFile(uploadedName);
    fileUri = (next as any)?.uri || (next as any)?.file?.uri;
    fileState = (next as any)?.state || (next as any)?.file?.state;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { fileData: { mimeType, fileUri } }
        ]
      }
    ]
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body),
    signal
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const err: any = new Error(`Gemini audio request failed: ${resp.status} ${resp.statusText} ${errText}`);
    err.status = resp.status;
    throw err;
  }

  const json = await resp.json();
  const text = extractTextFromResponse(json);
  if (!text) {
    throw new Error('Gemini returned an empty response for the audio request');
  }
  return text;
}

export function cancelAudioRequest() {
  if (currentController) {
    currentController.abort();
    currentController = null;
  }
}

type TranscribeOptions = {
  outputDir: string;
  modelName: string;
  apiKey: string;
  rawPrompt: string;
  interviewMode: boolean;
  subtitles: boolean;
  tempDir?: string;
  signal?: AbortSignal;
  logger?: (msg: string) => Promise<void> | void;
};

export async function transcribeAudioGemini(filePath: string, opts: TranscribeOptions): Promise<void> {
  const {
    outputDir,
    modelName,
    apiKey,
    rawPrompt,
    interviewMode,
    subtitles,
    signal,
    logger = async () => {}
  } = opts;

  const controller = new AbortController();
  currentController = controller;
  const useSignal = (() => {
    if (!signal) return controller.signal;
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
    return controller.signal;
  })();

  await fs.promises.mkdir(outputDir, { recursive: true });
  const base = path.basename(filePath, path.extname(filePath));
  const prompt = formatPrompt(rawPrompt, interviewMode, subtitles);

  let mimeType = AUDIO_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'audio/mpeg';
  let inputPath = filePath;
  let tmpMp3: string | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  try {
    if (useSignal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (path.extname(filePath).toLowerCase() !== '.mp3') {
      tmpMp3 = path.join(outputDir, `${base}.mp3`);
      await logger(`[INFO] Converting to mp3: ${tmpMp3}`);
      await runFfmpeg(['-y', '-i', filePath, '-codec:a', 'libmp3lame', '-qscale:a', '2', tmpMp3], useSignal);
      inputPath = tmpMp3;
      mimeType = 'audio/mpeg';
      cleanup = async () => { await fs.promises.rm(tmpMp3!).catch(() => {}); };
    }

    const totalDuration = await probeDurationSeconds(inputPath);
    await logger(`[INFO] Input duration: ${totalDuration.toFixed(2)}s`);

    const shouldSplit = totalDuration > LONG_AUDIO_SPLIT_THRESHOLD_SECONDS;

    if (shouldSplit) {
      const chunks = await createAudioChunks(inputPath, outputDir, base, totalDuration, useSignal, logger);
      try {
        if (subtitles) {
          const chunkCueLists: SrtCue[][] = [];

          for (let i = 0; i < chunks.length; i += 1) {
            const chunk = chunks[i];
            await logger(`[INFO] Uploading subtitle chunk ${i + 1}/${chunks.length} (${path.basename(chunk.audioPath)})`);
            const rawChunk = await uploadAndTranscribe(chunk.audioPath, prompt, modelName, apiKey, mimeType, useSignal);
            const parsed = parseSrtCues(rawChunk || '');
            if (!parsed.length) {
              throw new Error(`Subtitle chunk ${i + 1}/${chunks.length} did not return valid SRT content.`);
            }
            chunkCueLists.push(shiftSrtCues(parsed, chunk.startOffsetSeconds));
          }

          const mergedCues = mergeSrtCueLists(chunkCueLists);
          const srtText = serializeSrtCues(mergedCues);
          const srtPath = path.join(outputDir, `${base}.srt`);
          await fs.promises.writeFile(srtPath, srtText, 'utf-8');
          await logger(`[OK] SRT saved: ${srtPath}`);

          const txtFromSrt = srtCuesToTranscript(mergedCues);
          const txtPath = path.join(outputDir, `${base}.txt`);
          await fs.promises.writeFile(txtPath, txtFromSrt, 'utf-8');
          await logger(`[OK] Transcript (from merged SRT) saved: ${txtPath}`);
        } else if (interviewMode) {
          const chunkInterviewGroups: Array<Array<{ speaker?: string; transcription?: string }>> = [];
          const chunkRawTexts: string[] = [];
          let allChunksParsed = true;

          for (let i = 0; i < chunks.length; i += 1) {
            const chunk = chunks[i];
            await logger(`[INFO] Uploading interview chunk ${i + 1}/${chunks.length} (${path.basename(chunk.audioPath)})`);
            const rawChunk = await uploadAndTranscribe(chunk.audioPath, prompt, modelName, apiKey, mimeType, useSignal);
            const sanitized = sanitizeChunkText(rawChunk || '');
            chunkRawTexts.push(shiftBracketTimestamps(sanitized, chunk.startOffsetSeconds));

            const parsed = tryParseSpeakerJson(rawChunk || '');
            if (parsed) {
              chunkInterviewGroups.push(parsed);
            } else {
              allChunksParsed = false;
            }
          }

          const outTxt = path.join(outputDir, `${base}.txt`);
          if (allChunksParsed) {
            const mergedEntries = mergeInterviewEntries(chunkInterviewGroups);
            const pretty = formatSpeakerTranscript(mergedEntries);
            const outText = pretty.endsWith('\n') ? pretty : `${pretty}\n`;
            await fs.promises.writeFile(outTxt, outText, 'utf-8');
            await logger(`[OK] Interview JSON parsed across chunks: ${mergedEntries.length} entries.`);
            await logger(`[OK] Saved transcript: ${outTxt}`);
          } else {
            const mergedRaw = mergeTextChunks(chunkRawTexts);
            await fs.promises.writeFile(outTxt, mergedRaw, 'utf-8');
            await logger('[WARN] Interview chunk output was not consistently JSON; saved merged raw transcript.');
            await logger(`[OK] Saved transcript: ${outTxt}`);
          }
        } else {
          const chunkTexts: string[] = [];

          for (let i = 0; i < chunks.length; i += 1) {
            const chunk = chunks[i];
            await logger(`[INFO] Uploading transcript chunk ${i + 1}/${chunks.length} (${path.basename(chunk.audioPath)})`);
            const rawChunk = await uploadAndTranscribe(chunk.audioPath, prompt, modelName, apiKey, mimeType, useSignal);
            const shifted = shiftBracketTimestamps(sanitizeChunkText(rawChunk || ''), chunk.startOffsetSeconds);
            chunkTexts.push(shifted);
          }

          const combined = mergeTextChunks(chunkTexts);
          const combinedTxt = path.join(outputDir, `${base}.txt`);
          await fs.promises.writeFile(combinedTxt, combined, 'utf-8');
          await logger(`[OK] Saved merged TXT: ${combinedTxt}`);
        }
      } finally {
        await cleanupAudioChunks(chunks);
      }
    } else {
      await logger(`[INFO] Uploading full audio (${path.basename(inputPath)})`);
      const rawText = await uploadAndTranscribe(inputPath, prompt, modelName, apiKey, mimeType, useSignal);

      if (subtitles) {
        const normalized = normalizeSrtText(rawText || '');
        const srtText = normalized.srtText;
        const srtPath = path.join(outputDir, `${base}.srt`);
        await fs.promises.writeFile(srtPath, srtText, 'utf-8');
        await logger(`[OK] SRT saved: ${srtPath}`);

        const txtFromSrt = normalized.cues.length ? srtCuesToTranscript(normalized.cues) : srtToTranscript(srtText);
        const txtPath = path.join(outputDir, `${base}.txt`);
        await fs.promises.writeFile(txtPath, txtFromSrt, 'utf-8');
        await logger(`[OK] Transcript (from SRT) saved: ${txtPath}`);
      } else if (interviewMode) {
        const entries = tryParseSpeakerJson(rawText || '');
        let outText: string;
        if (entries) {
          const pretty = formatSpeakerTranscript(entries);
          outText = pretty.endsWith('\n') ? pretty : `${pretty}\n`;
          await logger(`[OK] Interview JSON parsed: ${entries.length} entries.`);
        } else {
          outText = rawText || '';
          await logger('[WARN] Interview mode: expected JSON, saving raw text.');
        }
        const outTxt = path.join(outputDir, `${base}.txt`);
        await fs.promises.writeFile(outTxt, outText, 'utf-8');
        await logger(`[OK] Saved transcript: ${outTxt}`);
      } else {
        const outTxt = path.join(outputDir, `${base}.txt`);
        await fs.promises.writeFile(outTxt, sanitizeChunkText(rawText || ''), 'utf-8');
        await logger(`[OK] Saved transcript: ${outTxt}`);
      }
    }
  } finally {
    if (cleanup) cleanup().catch(() => {});
    currentController = null;
  }
}

export async function transcribeAudioMistral(filePath: string, opts: TranscribeOptions): Promise<void> {
  const {
    outputDir,
    modelName,
    apiKey,
    interviewMode,
    subtitles,
    tempDir,
    signal,
    logger = async () => {}
  } = opts;

  const controller = new AbortController();
  currentController = controller;
  const useSignal = (() => {
    if (!signal) return controller.signal;
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
    return controller.signal;
  })();

  await fs.promises.mkdir(outputDir, { recursive: true });
  const workTempDir = tempDir ? path.resolve(tempDir) : outputDir;
  await fs.promises.mkdir(workTempDir, { recursive: true });
  const base = path.basename(filePath, path.extname(filePath));
  const tempRunId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  let inputPath = filePath;
  let tmpMp3: string | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  try {
    if (useSignal.aborted) throw new DOMException('Aborted', 'AbortError');

    if (path.extname(filePath).toLowerCase() !== '.mp3') {
      tmpMp3 = path.join(workTempDir, `${base}__source_${tempRunId}.mp3`);
      await logger(`[INFO] Converting to mp3: ${tmpMp3}`);
      await runFfmpeg(['-y', '-i', filePath, '-codec:a', 'libmp3lame', '-qscale:a', '2', tmpMp3], useSignal);
      inputPath = tmpMp3;
      cleanup = async () => { await fs.promises.rm(tmpMp3!).catch(() => {}); };
    }

    const totalDuration = await probeDurationSeconds(inputPath);
    await logger(`[INFO] Input duration: ${totalDuration.toFixed(2)}s`);
    const shouldSplit = totalDuration > LONG_AUDIO_SPLIT_THRESHOLD_SECONDS;

    if (shouldSplit) {
      const chunks = await createAudioChunks(inputPath, workTempDir, base, totalDuration, useSignal, logger);
      try {
        if (subtitles) {
          const chunkCueLists: SrtCue[][] = [];

          for (let i = 0; i < chunks.length; i += 1) {
            const chunk = chunks[i];
            await logger(`[INFO] Uploading subtitle chunk ${i + 1}/${chunks.length} (${path.basename(chunk.audioPath)})`);
            const result = await uploadAndTranscribeMistral(chunk.audioPath, modelName, apiKey, useSignal, {
              subtitles: true,
              interviewMode: false
            });
            const cues = result.segments.length
              ? mistralSegmentsToSrtCues(result.segments)
              : parseSrtCues(result.text || '');
            if (!cues.length) {
              throw new Error(`Subtitle chunk ${i + 1}/${chunks.length} did not return timestamped segments.`);
            }
            chunkCueLists.push(shiftSrtCues(cues, chunk.startOffsetSeconds));
          }

          const mergedCues = mergeSrtCueLists(chunkCueLists);
          const srtText = serializeSrtCues(mergedCues);
          const srtPath = path.join(outputDir, `${base}.srt`);
          await fs.promises.writeFile(srtPath, srtText, 'utf-8');
          await logger(`[OK] SRT saved: ${srtPath}`);

          const txtFromSrt = srtCuesToTranscript(mergedCues);
          const txtPath = path.join(outputDir, `${base}.txt`);
          await fs.promises.writeFile(txtPath, txtFromSrt, 'utf-8');
          await logger(`[OK] Transcript (from merged SRT) saved: ${txtPath}`);
        } else if (interviewMode) {
          const chunkInterviewGroups: Array<Array<{ speaker?: string; transcription?: string }>> = [];
          const chunkRawTexts: string[] = [];
          let allChunksParsed = true;

          for (let i = 0; i < chunks.length; i += 1) {
            const chunk = chunks[i];
            await logger(`[INFO] Uploading interview chunk ${i + 1}/${chunks.length} (${path.basename(chunk.audioPath)})`);
            const result = await uploadAndTranscribeMistral(chunk.audioPath, modelName, apiKey, useSignal, {
              subtitles: false,
              interviewMode: true
            });

            const fallbackChunkText = result.segments.length
              ? mistralSegmentsToTranscriptLines(result.segments).join('\n')
              : sanitizeChunkText(result.text || '');
            chunkRawTexts.push(shiftBracketTimestamps(fallbackChunkText, chunk.startOffsetSeconds));

            let entries: Array<{ speaker?: string; transcription?: string }> | null = null;
            if (result.segments.some(seg => typeof seg.speaker === 'string' && seg.speaker.trim())) {
              const fromSegments = mistralSegmentsToInterviewEntries(result.segments);
              if (fromSegments.length) entries = fromSegments;
            }
            if (!entries) {
              const parsed = tryParseSpeakerJson(result.text || '');
              if (parsed) entries = parsed;
            }

            if (entries && entries.length) {
              chunkInterviewGroups.push(entries);
            } else {
              allChunksParsed = false;
            }
          }

          const outTxt = path.join(outputDir, `${base}.txt`);
          if (allChunksParsed && chunkInterviewGroups.length === chunks.length) {
            const mergedEntries = mergeInterviewEntries(chunkInterviewGroups);
            const pretty = formatSpeakerTranscript(mergedEntries);
            const outText = pretty.endsWith('\n') ? pretty : `${pretty}\n`;
            await fs.promises.writeFile(outTxt, outText, 'utf-8');
            await logger(`[OK] Interview diarization parsed across chunks: ${mergedEntries.length} entries.`);
            await logger(`[OK] Saved transcript: ${outTxt}`);
          } else {
            const mergedRaw = mergeTextChunks(chunkRawTexts);
            await fs.promises.writeFile(outTxt, mergedRaw, 'utf-8');
            await logger('[WARN] Interview diarization unavailable for one or more chunks; saved merged raw transcript.');
            await logger(`[OK] Saved transcript: ${outTxt}`);
          }
        } else {
          const chunkTexts: string[] = [];

          for (let i = 0; i < chunks.length; i += 1) {
            const chunk = chunks[i];
            await logger(`[INFO] Uploading transcript chunk ${i + 1}/${chunks.length} (${path.basename(chunk.audioPath)})`);
            const result = await uploadAndTranscribeMistral(chunk.audioPath, modelName, apiKey, useSignal, {
              subtitles: false,
              interviewMode: false
            });
            const chunkText = result.segments.length
              ? mistralSegmentsToTranscriptLines(result.segments).join('\n')
              : sanitizeChunkText(result.text || '');
            const shifted = shiftBracketTimestamps(chunkText, chunk.startOffsetSeconds);
            chunkTexts.push(shifted);
          }

          const combined = mergeTextChunks(chunkTexts);
          const combinedTxt = path.join(outputDir, `${base}.txt`);
          await fs.promises.writeFile(combinedTxt, combined, 'utf-8');
          await logger(`[OK] Saved merged TXT: ${combinedTxt}`);
        }
      } finally {
        await cleanupAudioChunks(chunks);
      }
    } else {
      await logger(`[INFO] Uploading full audio (${path.basename(inputPath)})`);
      const result = await uploadAndTranscribeMistral(inputPath, modelName, apiKey, useSignal, {
        subtitles,
        interviewMode
      });

      if (subtitles) {
        const cues = result.segments.length
          ? mistralSegmentsToSrtCues(result.segments)
          : parseSrtCues(result.text || '');
        if (!cues.length) {
          throw new Error('Mistral subtitle mode returned no timestamped segments.');
        }

        const srtText = serializeSrtCues(cues);
        const srtPath = path.join(outputDir, `${base}.srt`);
        await fs.promises.writeFile(srtPath, srtText, 'utf-8');
        await logger(`[OK] SRT saved: ${srtPath}`);

        const txtFromSrt = srtCuesToTranscript(cues);
        const txtPath = path.join(outputDir, `${base}.txt`);
        await fs.promises.writeFile(txtPath, txtFromSrt, 'utf-8');
        await logger(`[OK] Transcript (from SRT) saved: ${txtPath}`);
      } else if (interviewMode) {
        let entries: Array<{ speaker?: string; transcription?: string }> | null = null;
        if (result.segments.some(seg => typeof seg.speaker === 'string' && seg.speaker.trim())) {
          const fromSegments = mistralSegmentsToInterviewEntries(result.segments);
          if (fromSegments.length) entries = fromSegments;
        }
        if (!entries) {
          entries = tryParseSpeakerJson(result.text || '');
        }

        let outText = '';
        if (entries && entries.length) {
          const pretty = formatSpeakerTranscript(entries);
          outText = pretty.endsWith('\n') ? pretty : `${pretty}\n`;
          await logger(`[OK] Interview diarization parsed: ${entries.length} entries.`);
        } else if (result.segments.length) {
          outText = mistralSegmentsToTranscriptLines(result.segments).join('\n');
          await logger('[WARN] Interview diarization missing speaker labels; saved timestamped transcript.');
        } else {
          outText = sanitizeChunkText(result.text || '');
          await logger('[WARN] Interview mode: expected diarized segments, saving raw text.');
        }
        const outTxt = path.join(outputDir, `${base}.txt`);
        await fs.promises.writeFile(outTxt, outText, 'utf-8');
        await logger(`[OK] Saved transcript: ${outTxt}`);
      } else {
        const outText = result.segments.length
          ? mistralSegmentsToTranscriptLines(result.segments).join('\n')
          : sanitizeChunkText(result.text || '');
        const outTxt = path.join(outputDir, `${base}.txt`);
        await fs.promises.writeFile(outTxt, outText, 'utf-8');
        await logger(`[OK] Saved transcript: ${outTxt}`);
      }
    }
  } finally {
    if (cleanup) cleanup().catch(() => {});
    currentController = null;
  }
}
