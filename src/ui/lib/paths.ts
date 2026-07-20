// Filesystem path / transcript-name helpers (renderer side, via the electron
// node bridge). Extracted verbatim from App.tsx.
import { fs, path as pathModule } from '../electron';
import type { Transcript } from '../components/AudioTranscriber';
import { ACCESSIBLE_PDF_PREFIX, AUDIO_EXTS, IMAGE_EXTS } from './constants';
import type { AudioReviewSegment, OcrReviewData } from './types';
import type { QualityEntry } from './quality';
import { parseSrtToSegments } from './audioReview';

export function normalizeLocalPath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return pathModule.normalize(pathModule.resolve(trimmed));
  } catch {
    return trimmed;
  }
}

export function resolveImageInputPathKind(value: string): 'file' | 'directory' | 'missing' {
  const normalized = normalizeLocalPath(value);
  if (!normalized) return 'missing';

  try {
    const stats = fs.statSync(normalized);
    if (stats.isDirectory()) return 'directory';
    if (stats.isFile()) return 'file';
  } catch {
    const ext = pathModule.extname(normalized).toLowerCase();
    if (IMAGE_EXTS.includes(ext) || AUDIO_EXTS.includes(ext)) return 'file';
    // The UI picker only allows folders here, so keep batch mode available
    // when a renderer-side stat check is the only thing failing.
    return 'directory';
  }

  return 'missing';
}

export function sortTranscripts(list: Transcript[]): Transcript[] {
  return [...list].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );
}

// Every list-transcripts IPC call returns brand-new objects, so a naive
// setState after every background poll would hand React a new array (and
// new item identities) even when nothing on disk changed — defeating
// React.memo on every row in the sidebar list each tick. Callers use this to
// keep the previous array/object identities when the content is unchanged,
// so an idle poll is a no-op re-render instead of a full-list repaint.
export function transcriptListsEqual(a: Transcript[], b: Transcript[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, i) => item.name === b[i].name && item.path === b[i].path);
}

export function sourceBaseNameForTranscript(transcriptName: string): string {
  const lowerName = transcriptName.toLowerCase();
  if (lowerName.endsWith('.txt') || lowerName.endsWith('.srt')) {
    return transcriptName.replace(/\.(txt|srt)$/i, '');
  }
  if (
    lowerName.startsWith(ACCESSIBLE_PDF_PREFIX.toLowerCase())
    && (lowerName.endsWith('.pdf') || lowerName.endsWith('.html'))
  ) {
    return transcriptName.slice(ACCESSIBLE_PDF_PREFIX.length, lowerName.endsWith('.html') ? -5 : -4);
  }
  if (lowerName.endsWith('.pdf') || lowerName.endsWith('.html')) {
    return transcriptName.slice(0, lowerName.endsWith('.html') ? -5 : -4);
  }
  return transcriptName;
}

export function resolveSourceFileForTranscript(
  transcript: Transcript,
  inputPath: string,
  outputDir: string,
  exts: string[]
): string | null {
  if (!inputPath) return null;
  const sourceBaseName = sourceBaseNameForTranscript(transcript.name);
  if (!sourceBaseName) return null;

  try {
    if (fs.statSync(inputPath).isFile()) {
      const inputBaseName = pathModule.basename(inputPath, pathModule.extname(inputPath));
      return inputBaseName === sourceBaseName ? inputPath : null;
    }
  } catch {
    return null;
  }

  const candidateDirs: string[] = [];
  if (outputDir && transcript.path) {
    const relativePath = pathModule.relative(outputDir, transcript.path);
    if (relativePath && !relativePath.startsWith('..') && !pathModule.isAbsolute(relativePath)) {
      const relativeDir = pathModule.dirname(relativePath);
      if (relativeDir && relativeDir !== '.') {
        candidateDirs.push(pathModule.join(inputPath, relativeDir));
      }
    }
  }
  candidateDirs.push(inputPath);

  for (const baseDir of candidateDirs) {
    for (const ext of exts) {
      const candidate = pathModule.join(baseDir, `${sourceBaseName}${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

export function ensureUniquePath(destDir: string, baseName: string): string {
  const ext = pathModule.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  let candidate = pathModule.join(destDir, baseName);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    const nextName = `${stem}_${counter}${ext}`;
    candidate = pathModule.join(destDir, nextName);
    counter += 1;
  }
  return candidate;
}

// Mirrors main.ts's OCR_METADATA_SUBDIR — kept in its own subfolder so an output
// folder browsed in Finder/Explorer only shows the user's actual transcripts.
const OCR_METADATA_SUBDIR = '.mistral_ocr_meta';

export function ocrReviewSidecarPathForTranscript(txtPath: string): string {
  const dir = pathModule.dirname(txtPath);
  const base = pathModule.basename(txtPath, pathModule.extname(txtPath));
  return pathModule.join(dir, OCR_METADATA_SUBDIR, `${base}.ocrmeta.json`);
}

export function loadOcrReviewData(txtPath: string): OcrReviewData | null {
  try {
    const raw = fs.readFileSync(ocrReviewSidecarPathForTranscript(txtPath), 'utf-8');
    return JSON.parse(raw) as OcrReviewData;
  } catch {
    return null;
  }
}

// Audio Review's timing data lives in a sibling .srt (only written when
// "Generate subtitles" was checked at transcribe time), so these convert
// between either the .txt or .srt row a user might right-click in the sidebar.
export function srtPathForTranscript(anyPath: string): string {
  const dir = pathModule.dirname(anyPath);
  const base = pathModule.basename(anyPath).replace(/\.(txt|srt)$/i, '');
  return pathModule.join(dir, `${base}.srt`);
}

export function txtPathForTranscript(anyPath: string): string {
  const dir = pathModule.dirname(anyPath);
  const base = pathModule.basename(anyPath).replace(/\.(txt|srt)$/i, '');
  return pathModule.join(dir, `${base}.txt`);
}

export function loadAudioReviewSegments(srtPath: string): AudioReviewSegment[] | null {
  try {
    return parseSrtToSegments(fs.readFileSync(srtPath, 'utf-8'));
  } catch {
    return null;
  }
}

// Mirrors main.ts's mistralPdfPathForTranscript (main and renderer are
// separate bundles, so this three-line join is duplicated rather than
// shared) — used to detect a stale accessible PDF after a text edit.
export function accessiblePdfPathForTranscript(txtPath: string): string {
  const dir = pathModule.dirname(txtPath);
  const base = pathModule.basename(txtPath, pathModule.extname(txtPath));
  return pathModule.join(dir, `${ACCESSIBLE_PDF_PREFIX}${base}.pdf`);
}

// Confidence entries derived from Mistral OCR sidecars, keyed by sidecar
// path. The transcript list re-renders every few seconds, so entries are
// cached by mtime: statSync per refresh, JSON.parse only when the sidecar
// actually changed. Returning the same object while unchanged also keeps
// React.memo effective on the list rows.
const mistralQualityCache = new Map<string, { mtimeMs: number; entry: QualityEntry | null }>();

export async function loadMistralQualityEntry(transcript: Transcript): Promise<QualityEntry | null> {
  const base = sourceBaseNameForTranscript(transcript.name);
  if (!base) return null;
  const sidecarPath = pathModule.join(pathModule.dirname(transcript.path), OCR_METADATA_SUBDIR, `${base}.ocrmeta.json`);
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.promises.stat(sidecarPath)).mtimeMs;
  } catch {
    return null;
  }
  const cached = mistralQualityCache.get(sidecarPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.entry;

  let entry: QualityEntry | null = null;
  try {
    const data = JSON.parse(await fs.promises.readFile(sidecarPath, 'utf-8')) as OcrReviewData;
    const scores = data.pages
      .map(p => p.averageConfidence)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (scores.length) {
      entry = { confidence: (scores.reduce((a, b) => a + b, 0) / scores.length) * 100, mistralConfidence: true };
    }
  } catch {
    entry = null;
  }
  mistralQualityCache.set(sidecarPath, { mtimeMs, entry });
  return entry;
}

export function splitTranscriptNameForMiddleEllipsis(name: string): { start: string; end: string } {
  if (!name) return { start: '', end: '' };
  const ext = pathModule.extname(name);
  const minTail = ext && ext.length < name.length ? ext.length : 0;
  const desiredTail = Math.min(
    28,
    Math.max(minTail + 10, 16),
    Math.max(name.length - 1, 1)
  );
  if (name.length <= desiredTail + 8) {
    return { start: name, end: '' };
  }
  return {
    start: name.slice(0, name.length - desiredTail),
    end: name.slice(name.length - desiredTail)
  };
}
