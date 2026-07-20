// Run with: node --test src/ui/lib/ocrReview.test.mjs
// (plain node:test — the repo has no installed test runner, and Node 24
// type-stripping loads the .ts source directly)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alignWordsToBlocks,
  alignWordsToRawText,
  bboxToDisplayRect,
  CONFIDENCE_LEGEND,
  confidenceColor,
  confidenceLabel,
  confidenceTierRank,
  isLineBreakWord,
  isRenderableWord,
  readJpegOrientation
} from './ocrReview.ts';

// Mirrors the real Mistral OCR 4 payload shape that broke naive token
// pairing: words carry leading spaces and bare "\n" entries, table blocks
// gain markdown pipes/`---` rows the word stream doesn't have, and heading
// blocks gain "#" markers.
const blocks = [
  { type: 'title', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, text: '# Kvinden og Hjemmet' },
  { type: 'table', bbox: { x0: 0, y0: 1, x1: 1, y1: 2 }, text: '| WHEN DUE. | PRINCIPAL. |\n| --- | --- |\n| Dec 1st | $100 |' },
  { type: 'image', bbox: { x0: 0, y0: 2, x1: 1, y1: 3 }, text: '![img-0.jpeg](img-0.jpeg)' },
  { type: 'text', bbox: { x0: 0, y0: 3, x1: 1, y1: 4 }, text: 'ESTABLISHED 1898.\nCEDAR RAPIDS, IOWA' }
];

const w = (text, confidence = 0.99) => ({ text, confidence });
const words = [
  w('#'), w(' Kvinden'), w(' og'), w(' Hjemmet'),
  w('WHEN'), w(' DUE.'), w('PRINCIPAL.'), w('Dec'), w(' 1st'), w('$100'),
  w('ESTABLISHED'), w(' 1898.'), w('\n'), w('CEDAR', 0.4), w(' RAPIDS,'), w(' IOWA')
];

test('words land in their own blocks despite markdown noise and newline entries', () => {
  const groups = alignWordsToBlocks(blocks, words);
  const texts = groups.map(g => g.filter(isRenderableWord).map(x => x.text.trim()));
  assert.deepEqual(texts[0], ['Kvinden', 'og', 'Hjemmet']);
  assert.deepEqual(texts[1], ['WHEN', 'DUE.', 'PRINCIPAL.', 'Dec', '1st', '$100']);
  assert.deepEqual(texts[2], []); // image block: no words, renders a placeholder
  assert.deepEqual(texts[3], ['ESTABLISHED', '1898.', 'CEDAR', 'RAPIDS,', 'IOWA']);
  // the "\n" entry stays in the last block as a line break, not a word
  assert.equal(groups[3].filter(isLineBreakWord).length, 1);
});

test('empty inputs do not throw', () => {
  assert.deepEqual(alignWordsToBlocks([], words), []);
  assert.deepEqual(alignWordsToBlocks(blocks, []), [[], [], [], []]);
});

test('alignWordsToRawText maps words to their real positions in the saved text', () => {
  const rawText = 'CEDAR RAPIDS, IOWA';
  const pages = [{ words: [w('CEDAR', 0.4), w(' RAPIDS,'), w(' IOWA')] }];
  const offsets = alignWordsToRawText(rawText, pages);
  assert.deepEqual(rawText.slice(...Object.values(offsets.get(pages[0].words[0]))), 'CEDAR');
  assert.deepEqual(rawText.slice(...Object.values(offsets.get(pages[0].words[1]))), 'RAPIDS,');
  assert.deepEqual(rawText.slice(...Object.values(offsets.get(pages[0].words[2]))), 'IOWA');
});

test('alignWordsToRawText fills the gap for a single word stranded between two matched neighbors', () => {
  // Mistral's two OCR passes (markdown text vs. word-confidence stream)
  // sometimes disagree on one low-confidence token — the word stream says
  // "2122" but the saved file actually says "2182". Since both neighbors
  // still match, the gap between them pins down where the real text is.
  const rawText = 'No. 2182\n\nAGREEMENT.';
  const pages = [{ words: [w('No.'), w(' 2122', 0.6), w('AGREEMENT.')] }];
  const offsets = alignWordsToRawText(rawText, pages);
  const range = offsets.get(pages[0].words[1]);
  assert.ok(range);
  assert.equal(rawText.slice(range.start, range.end), '2182');
});

test('alignWordsToRawText leaves an ambiguous run of stranded words unmapped', () => {
  const rawText = 'the quick fox';
  const pages = [{ words: [w('the'), w(' slow'), w(' lazy'), w(' fox')] }];
  const offsets = alignWordsToRawText(rawText, pages);
  assert.ok(offsets.has(pages[0].words[0]));
  assert.ok(!offsets.has(pages[0].words[1])); // two consecutive misses — too ambiguous to split
  assert.ok(!offsets.has(pages[0].words[2]));
  assert.ok(offsets.has(pages[0].words[3]));
});

test('alignWordsToRawText leaves a word unmapped when nothing but whitespace separates its neighbors', () => {
  const rawText = 'the fox'; // "slow" was dropped entirely, not just misrecognized
  const pages = [{ words: [w('the'), w(' slow'), w(' fox')] }];
  const offsets = alignWordsToRawText(rawText, pages);
  assert.ok(!offsets.has(pages[0].words[1]));
});

test('alignWordsToRawText does not match a digit embedded inside a longer number', () => {
  // A naive indexOf search for "1" starting right after "note " would land
  // on the "1" inside "21" rather than skipping ahead to the standalone "1".
  const rawText = 'note 21 then 1 more';
  const pages = [{ words: [w('note'), w(' 21'), w(' then'), w(' 1'), w(' more')] }];
  const offsets = alignWordsToRawText(rawText, pages);
  const range = offsets.get(pages[0].words[3]);
  assert.equal(rawText.slice(range.start, range.end), '1');
  assert.equal(range.start, rawText.indexOf(' 1 more') + 1);
});

test('alignWordsToRawText carries the cursor across pages', () => {
  const rawText = 'first page\n\nsecond page';
  const pages = [{ words: [w('first'), w(' page')] }, { words: [w('second'), w(' page')] }];
  const offsets = alignWordsToRawText(rawText, pages);
  assert.deepEqual(rawText.slice(...Object.values(offsets.get(pages[1].words[0]))), 'second');
  assert.deepEqual(rawText.slice(...Object.values(offsets.get(pages[1].words[1]))), 'page');
});

// Minimal JPEG: SOI + EXIF APP1 segment with a single IFD0 entry holding the
// orientation tag (0x0112). `little` switches the TIFF byte order.
function jpegWithOrientation(orientation, little = false) {
  const b16 = v => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const b32 = v => (little ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  const tiff = [
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...b16(42), ...b32(8), // header + IFD0 offset
    ...b16(1), // one entry
    ...b16(0x0112), ...b16(3), ...b32(1), ...b16(orientation), ...b16(0), // orientation tag, SHORT
    ...b32(0) // next IFD
  ];
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // "Exif\0\0" + TIFF
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, ...((v => [v >> 8, v & 0xff])(app1.length + 2)), ...app1, 0xff, 0xd9]);
}

test('readJpegOrientation parses both byte orders and rejects junk', () => {
  assert.equal(readJpegOrientation(jpegWithOrientation(6)), 6);
  assert.equal(readJpegOrientation(jpegWithOrientation(8, true)), 8);
  assert.equal(readJpegOrientation(jpegWithOrientation(1)), 1);
  assert.equal(readJpegOrientation(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])), 1); // no EXIF
  assert.equal(readJpegOrientation(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), 1); // PNG
  assert.equal(readJpegOrientation(new Uint8Array(0)), 1);
});

test('confidenceLabel and confidenceColor agree on tier boundaries', () => {
  assert.equal(confidenceLabel(0.99), 'Confident');
  assert.equal(confidenceLabel(0.95), 'Worth a check');
  assert.equal(confidenceColor(0.95, '#000'), '#ca8a04');
  assert.equal(confidenceLabel(0.8), 'Uncertain');
  assert.equal(confidenceColor(0.8, '#000'), '#ea580c');
  assert.equal(confidenceLabel(0.5), 'Likely wrong');
  assert.equal(confidenceColor(0.5, '#000'), '#dc2626');
  assert.equal(confidenceColor(0.99, '#000'), '#000');
});

test('CONFIDENCE_LEGEND lists tiers worst-first', () => {
  assert.deepEqual(CONFIDENCE_LEGEND.map(t => t.label), ['Likely wrong', 'Uncertain', 'Worth a check']);
});

test('confidenceTierRank orders the flag jump worst-tier-first', () => {
  assert.equal(confidenceTierRank(0.5), 0);  // Likely wrong
  assert.equal(confidenceTierRank(0.8), 1);  // Uncertain
  assert.equal(confidenceTierRank(0.95), 2); // Worth a check
  // Same tier, different exact confidence -> same rank, so a later tiebreak
  // (reading order) decides instead of the raw score.
  assert.equal(confidenceTierRank(0.5), confidenceTierRank(0.7));
});

test('bboxToDisplayRect maps stored-frame boxes into the displayed frame', () => {
  // 400x300 stored image, box near the stored top-left
  const bbox = { x0: 40, y0: 30, x1: 120, y1: 60 };
  const upright = bboxToDisplayRect(bbox, 400, 300, 1);
  assert.deepEqual(upright, { left: 10, top: 10, width: 20, height: 10 });
  // 180°: lands near displayed bottom-right, same size
  const flipped = bboxToDisplayRect(bbox, 400, 300, 3);
  assert.deepEqual(flipped, { left: 70, top: 80, width: 20, height: 10 });
  // 90° CW (orientation 6): displayed frame is 300x400; stored top-left
  // corner appears at the displayed top-right
  const cw = bboxToDisplayRect(bbox, 400, 300, 6);
  assert.deepEqual(cw, { left: 80, top: 10, width: 10, height: 20 });
  // 90° CCW (orientation 8): stored top-left appears at displayed bottom-left
  const ccw = bboxToDisplayRect(bbox, 400, 300, 8);
  assert.deepEqual(ccw, { left: 10, top: 70, width: 10, height: 20 });
});
