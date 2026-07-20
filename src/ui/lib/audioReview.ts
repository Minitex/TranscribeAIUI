// SRT <-> AudioReviewSegment conversions for the Audio Review modal. Kept
// renderer-side and self-contained (rather than importing from
// src/electron/audioTranscribe.ts, a separate main-process bundle) but the
// timestamp format is a byte-compatible port of that file's parseSrtTimestamp
// / formatSrtTimestamp, so files written by either stay interchangeable.
import type { AudioReviewSegment } from './types';

export function parseSrtTimestamp(raw: string): number | null {
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

export function formatSrtTimestamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const h = Math.floor(safe / 3_600_000);
  const remAfterHours = safe % 3_600_000;
  const m = Math.floor(remAfterHours / 60_000);
  const remAfterMinutes = remAfterHours % 60_000;
  const s = Math.floor(remAfterMinutes / 1_000);
  const millis = remAfterMinutes % 1_000;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${millis.toString().padStart(3, '0')}`;
}

export function formatTranscriptTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const rem = totalSeconds % 3600;
  const m = Math.floor(rem / 60);
  const s = rem % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function parseSrtToSegments(rawText: string): AudioReviewSegment[] {
  const normalized = (rawText || '').replace(/\r/g, '').trim();
  if (!normalized) return [];

  const blocks = normalized.split(/\n{2,}/);
  const segments: AudioReviewSegment[] = [];

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

    segments.push({ startMs, endMs: Math.max(endMs, startMs + 1), text });
  }

  segments.sort((a, b) => a.startMs - b.startMs);
  return segments;
}

export function segmentsToSrtText(segments: AudioReviewSegment[]): string {
  if (!segments.length) return '';
  return `${segments.map((seg, index) =>
    `${index + 1}\n${formatSrtTimestamp(seg.startMs)} --> ${formatSrtTimestamp(seg.endMs)}\n${seg.text.trim()}`
  ).join('\n\n')}\n`;
}

export function segmentsToTranscriptText(segments: AudioReviewSegment[]): string {
  return segments
    .map(seg => ({ startMs: seg.startMs, text: seg.text.replace(/\s+/g, ' ').trim() }))
    .filter(seg => seg.text)
    .map(seg => `[${formatTranscriptTimestamp(seg.startMs)}] ${seg.text}`)
    .join('\n');
}

// Segment counts are subtitle-cue sized (dozens to low hundreds), so a plain
// scan on every timeupdate tick is cheap enough — no need for a binary search.
export function findActiveSegmentIndex(segments: AudioReviewSegment[], currentMs: number): number {
  return segments.findIndex(seg => currentMs >= seg.startMs && currentMs < seg.endMs);
}

export const AUDIO_MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wma': 'audio/x-ms-wma',
  '.mp4': 'audio/mp4',
  '.webm': 'audio/webm',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff'
};
