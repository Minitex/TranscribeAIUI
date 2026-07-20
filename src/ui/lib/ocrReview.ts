// Assigns Mistral OCR word-confidence entries to their content blocks.
//
// The API returns these as two independent page-level arrays with no join
// key: `words` is the raw recognition stream (entries keep leading spaces,
// and bare "\n" separators appear as their own entries), while each block's
// `text` is rendered markdown (tables gain `|` and `| --- |` syntax, headings
// gain `#`, none of which exist in the word stream). Counting tokens to pair
// them therefore drifts further with every table or multi-line block — so we
// align by character content instead: strip markdown syntax and whitespace
// from both sides and consume words that prefix-match the block's remaining
// text, with a bounded look-ahead to resynchronize past genuine mismatches.
import type { OcrReviewBlock, OcrReviewPage, OcrReviewWord } from './types';

// Reads the EXIF orientation tag (1-8) from JPEG bytes, defaulting to 1
// (upright) for non-JPEGs, missing EXIF, or malformed data. Needed because
// Mistral reports bounding boxes in the file's stored pixel frame, while
// Chromium displays <img> auto-rotated per this tag — a phone photo saved
// sideways (orientation 6) would otherwise get overlays rotated 90°.
export function readJpegOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1];
    if (marker === 0xda || marker === 0xd9) break; // image data starts; no EXIF ahead
    const size = (bytes[i + 2] << 8) | bytes[i + 3];
    if (size < 2 || i + 2 + size > bytes.length) break;
    const isExifApp1 = marker === 0xe1 && size >= 8
      && bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78 && bytes[i + 6] === 0x69
      && bytes[i + 7] === 0x66 && bytes[i + 8] === 0 && bytes[i + 9] === 0;
    if (isExifApp1) {
      const tiff = i + 10;
      if (tiff + 8 > bytes.length) return 1;
      const little = bytes[tiff] === 0x49;
      const u16 = (o: number) => (little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
      const u32 = (o: number) =>
        (little
          ? bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)
          : (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > bytes.length) return 1;
      const count = u16(ifd);
      for (let e = 0; e < count; e++) {
        const off = ifd + 2 + e * 12;
        if (off + 12 > bytes.length) return 1;
        if (u16(off) === 0x0112) {
          const value = u16(off + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    i += 2 + size;
  }
  return 1;
}

export type DisplayRect = { left: number; top: number; width: number; height: number };

// Maps a bounding box from the stored pixel frame (what Mistral saw and
// reported against) into percentages of the browser-displayed image, which
// Chromium auto-rotates per EXIF orientation. Orientations 3/6/8 are the
// rotations cameras actually produce; the mirrored variants (2/4/5/7) fall
// back to upright since no capture pipeline emits them in practice.
export function bboxToDisplayRect(
  bbox: OcrReviewBlock['bbox'],
  storedWidth: number,
  storedHeight: number,
  orientation: number
): DisplayRect {
  let left = bbox.x0;
  let top = bbox.y0;
  let right = bbox.x1;
  let bottom = bbox.y1;
  let displayWidth = storedWidth;
  let displayHeight = storedHeight;
  if (orientation === 3) {
    // 180°
    left = storedWidth - bbox.x1;
    top = storedHeight - bbox.y1;
    right = storedWidth - bbox.x0;
    bottom = storedHeight - bbox.y0;
  } else if (orientation === 6) {
    // stored is rotated 90° CW for display
    left = storedHeight - bbox.y1;
    top = bbox.x0;
    right = storedHeight - bbox.y0;
    bottom = bbox.x1;
    displayWidth = storedHeight;
    displayHeight = storedWidth;
  } else if (orientation === 8) {
    // stored is rotated 90° CCW for display
    left = bbox.y0;
    top = storedWidth - bbox.x1;
    right = bbox.y1;
    bottom = storedWidth - bbox.x0;
    displayWidth = storedHeight;
    displayHeight = storedWidth;
  }
  return {
    left: (left / displayWidth) * 100,
    top: (top / displayHeight) * 100,
    width: ((right - left) / displayWidth) * 100,
    height: ((bottom - top) / displayHeight) * 100
  };
}

// Strips whitespace plus the markdown syntax characters Mistral adds to
// block text (table pipes, heading markers, emphasis, `---` rows). Applied
// to both sides of every comparison, so a stripped character can never
// cause a mismatch — only text genuinely absent from one side can.
function stripForAlign(value: string): string {
  return value.replace(/[\s|#*_`~\\-]+/g, '');
}

export function isLineBreakWord(word: OcrReviewWord): boolean {
  return !stripForAlign(word.text) && word.text.includes('\n');
}

export function isRenderableWord(word: OcrReviewWord): boolean {
  return Boolean(stripForAlign(word.text));
}

// The three below-full-confidence tiers, checked highest threshold first
// (mirrors the original if/else chain). Single source of truth for both the
// word color and its plain-English name, so the two can never drift apart
// the way the flag threshold once did.
const CONFIDENCE_TIERS: { min: number; label: string; color: string }[] = [
  { min: 0.9, label: 'Worth a check', color: '#ca8a04' }, // yellow
  { min: 0.75, label: 'Uncertain', color: '#ea580c' },    // orange
  { min: 0, label: 'Likely wrong', color: '#dc2626' }     // red — catches everything else
];
const FULL_CONFIDENCE_MIN = 0.97;

function confidenceTier(confidence: number) {
  return CONFIDENCE_TIERS.find(t => confidence >= t.min) ?? CONFIDENCE_TIERS[CONFIDENCE_TIERS.length - 1];
}

// The "fully confident" color is caller-supplied since it differs by
// background (black text reads on the review pane's white background, but
// not on a dark sidebar row).
export function confidenceColor(confidence: number, fullConfidenceColor: string): string {
  if (confidence >= FULL_CONFIDENCE_MIN) return fullConfidenceColor;
  return confidenceTier(confidence).color;
}

// Plain-English name for a word's confidence tier (e.g. "Likely wrong" for
// a red word), so a first-time user can learn what the colors mean from a
// tooltip instead of having to guess.
export function confidenceLabel(confidence: number): string {
  if (confidence >= FULL_CONFIDENCE_MIN) return 'Confident';
  return confidenceTier(confidence).label;
}

// Ordering key for the flag jump: 0 = "Likely wrong", 1 = "Uncertain",
// 2 = "Worth a check". Lets the reviewer clear the whole worst tier (in
// reading order) before moving on to milder ones, instead of hopping around
// the page by exact confidence.
export function confidenceTierRank(confidence: number): number {
  return CONFIDENCE_TIERS.length - 1 - CONFIDENCE_TIERS.indexOf(confidenceTier(confidence));
}

// Swatch + name for each below-full-confidence tier, worst first — for a
// small always-visible color key so the meaning of red/orange/yellow
// doesn't have to be discovered by trial and error.
export const CONFIDENCE_LEGEND: { label: string; color: string }[] =
  [...CONFIDENCE_TIERS].reverse().map(({ label, color }) => ({ label, color }));

// How far ahead (in stripped characters) we search when the next word does
// not sit exactly at the alignment cursor. Long enough to skip a dropped
// word or two, short enough that a false match cannot jump a paragraph.
const RESYNC_WINDOW = 48;

export type WordOffset = { start: number; end: number };

// How far ahead (in characters) we'll look for a word's next occurrence in
// the real saved text before giving up on mapping it. Long enough to skip a
// stray unmatched token; short enough that a common short word doesn't snap
// onto a wrong, far-away occurrence.
const TEXT_RESYNC_WINDOW = 200;

const isWordChar = (ch: string): boolean => /[A-Za-z0-9]/.test(ch);

// A raw indexOf match is only a real occurrence of `text` if it isn't sitting
// inside a longer run of the same character class — otherwise a short token
// like "1" matches the "1" inside "100" instead of the standalone "1" that
// comes later. Numbers suffer from this constantly (tables are full of short
// digit runs that are substrings of longer ones nearby); this also protects
// ordinary words from matching inside a longer word.
function indexOfWholeToken(haystack: string, text: string, fromIndex: number, maxIndex: number): number {
  let searchFrom = fromIndex;
  for (;;) {
    const idx = haystack.indexOf(text, searchFrom);
    if (idx < 0 || idx > maxIndex) return -1;
    const before = idx > 0 ? haystack[idx - 1] : '';
    const after = idx + text.length < haystack.length ? haystack[idx + text.length] : '';
    const startOk = !isWordChar(text[0]) || !isWordChar(before);
    const endOk = !isWordChar(text[text.length - 1]) || !isWordChar(after);
    if (startOk && endOk) return idx;
    searchFrom = idx + 1;
  }
}

// Maps every renderable OCR word, across all pages in reading order, to its
// character range in the actual saved transcript text — so a single word
// can be patched in place (inline editing) without touching the rest of the
// file. Unlike alignWordsToBlocks (which aligns against each block's
// markdown, purely to group words for display), this aligns against the
// real saved text, which the word stream already matches closely since
// neither carries markdown.
export function alignWordsToRawText(
  rawText: string,
  pages: Pick<OcrReviewPage, 'words'>[]
): Map<OcrReviewWord, WordOffset> {
  const renderable: OcrReviewWord[] = [];
  for (const page of pages) {
    for (const word of page.words) {
      if (isRenderableWord(word)) renderable.push(word);
    }
  }

  const offsets = new Map<OcrReviewWord, WordOffset>();
  const matched: boolean[] = renderable.map(() => false);
  let cursor = 0;
  renderable.forEach((word, i) => {
    const text = word.text.trim();
    const idx = indexOfWholeToken(rawText, text, cursor, cursor + TEXT_RESYNC_WINDOW);
    if (idx < 0) return;
    offsets.set(word, { start: idx, end: idx + text.length });
    matched[i] = true;
    cursor = idx + text.length;
  });

  // Mistral's markdown pass and its word-confidence pass are two separate
  // model outputs for the same page, and occasionally disagree on a single
  // low-confidence token (a misread digit is the classic case — the word
  // stream says "2122", the saved text says "2182"). That word's own text
  // will never be found, but its neighbors usually still match on both
  // sides, which pins down exactly where it really sits: the gap between
  // them. Only isolated single mismatches get this treatment — a run of two
  // or more unmatched words in a row is too ambiguous to carve up safely,
  // so those stay unmapped (uneditable) rather than guessed at.
  renderable.forEach((word, i) => {
    if (matched[i]) return;
    const prevOk = i === 0 || matched[i - 1];
    const nextOk = i === renderable.length - 1 || matched[i + 1];
    if (!prevOk || !nextOk) return;
    const gapStart = i > 0 ? offsets.get(renderable[i - 1])!.end : 0;
    const gapEnd = i < renderable.length - 1 ? offsets.get(renderable[i + 1])!.start : rawText.length;
    if (gapEnd <= gapStart) return;
    const gap = rawText.slice(gapStart, gapEnd);
    const start = gapStart + (gap.length - gap.trimStart().length);
    const end = gapEnd - (gap.length - gap.trimEnd().length);
    if (end <= start) return; // nothing but whitespace between the neighbors
    offsets.set(word, { start, end });
  });

  return offsets;
}

export function alignWordsToBlocks(
  blocks: OcrReviewBlock[],
  words: OcrReviewWord[]
): OcrReviewWord[][] {
  const groups: OcrReviewWord[][] = blocks.map(() => []);
  if (!blocks.length) return groups;

  const targets = blocks.map(b => stripForAlign(b.text));
  let bi = 0;
  let pos = 0;

  for (const word of words) {
    if (bi >= blocks.length) {
      groups[blocks.length - 1].push(word);
      continue;
    }
    const nw = stripForAlign(word.text);
    if (!nw) {
      // Newlines and markdown-only entries carry no alignment information;
      // keep them in the current block so line breaks render in place.
      groups[bi].push(word);
      continue;
    }

    for (;;) {
      const target = targets[bi];
      if (pos < target.length) {
        if (target.startsWith(nw, pos)) {
          pos += nw.length;
          groups[bi].push(word);
          break;
        }
        const idx = target.indexOf(nw, pos);
        if (idx >= 0 && idx - pos <= RESYNC_WINDOW) {
          pos = idx + nw.length;
          groups[bi].push(word);
          break;
        }
      }
      if (bi + 1 < blocks.length) {
        const nextIdx = targets[bi + 1].indexOf(nw);
        if (nextIdx >= 0 && nextIdx <= RESYNC_WINDOW) {
          bi += 1;
          pos = nextIdx + nw.length;
          groups[bi].push(word);
          break;
        }
        if (pos >= target.length) {
          bi += 1;
          pos = 0;
          continue;
        }
      }
      // No block claims this word; keep it where the stream says it belongs
      // rather than dropping recognized text from the review.
      groups[bi].push(word);
      break;
    }
  }

  return groups;
}
