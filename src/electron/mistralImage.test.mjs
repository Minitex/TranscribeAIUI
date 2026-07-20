// Run with: node --test src/electron/mistralImage.test.mjs
// (plain node:test — Node 24 type-stripping loads the .ts source directly)
//
// cleanMarkdown now runs on a worker thread (see markdownRenderWorker.ts) so
// it never blocks Electron's main process, which makes it async -- hence
// `await` below. The assertions/expected strings are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMarkdown } from './mistralImage.ts';

test('cleanMarkdown keeps currency dollar signs instead of treating them as LaTeX delimiters', async () => {
  const cleaned = await cleanMarkdown('Dec 1st  $100\nJan 2nd  $250\n');
  assert.match(cleaned, /\$100/);
  assert.match(cleaned, /\$250/);
});

test('cleanMarkdown still strips real inline math delimiters', async () => {
  assert.equal(await cleanMarkdown('Energy is $E=mc^2$ today.'), 'Energy is E=mc^2 today.');
  assert.equal(await cleanMarkdown('$$a^2 + b^2 = c^2$$'), 'a^2 + b^2 = c^2');
});

test('cleanMarkdown converts table rows to space-joined cells', async () => {
  const cleaned = await cleanMarkdown('| Dec 1st | $100 |\n| Jan 2nd | $250 |');
  assert.equal(cleaned, 'Dec 1st $100 Jan 2nd $250');
});
