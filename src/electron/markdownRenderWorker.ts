import { Worker, isMainThread, parentPort } from 'worker_threads';
import path from 'path';
import katex from 'katex';

// ============================================================================
// This file holds the pure, synchronous, regex-heavy markdown/HTML rendering
// code that used to live inline in main.ts (renderMarkdownLikeHtml and its
// helpers) and mistralImage.ts (embedImagesIntoMarkdown, cleanMarkdown).
//
// A single-pass regex.replace chain over a large OCR markdown document can
// take a noticeable amount of wall-clock time. Running it directly on
// Electron's main-process event loop would freeze every window and all IPC
// for the duration of a big export. So this module doubles as a
// worker_threads entry point: when Node loads it as a Worker (see
// getSharedWorker() below), isMainThread is false and it starts listening on
// parentPort for render requests instead of exporting anything useful to a
// normal importer.
//
// main.ts and mistralImage.ts never talk to worker_threads directly -- they
// import callMarkdownWorker() (at the bottom of this file) and a handful of
// small/cheap helpers (escapeHtml, sanitizeLanguageTag,
// resolveAccessibleDocumentTitle, and the AccessiblePdfPageContent /
// RenderMarkdownOptions types) that are still called synchronously outside
// the heavy render path.
//
// Every function below is moved verbatim from main.ts / mistralImage.ts --
// no logic changes, only (a) deduping two helpers (collapseWhitespace,
// safeDecodeURIComponent) that were byte-for-byte identical in both source
// files, and (b) adding `export` to the handful of symbols still needed
// directly by main.ts.
// ============================================================================

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·'
};

function decodeHtmlEntities(value: string): string {
  if (!value || !value.includes('&')) return value;

  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decoded.replace(/&(#(?:x[a-fA-F0-9]+|\d+)|[a-zA-Z][a-zA-Z0-9]+);/g, (match, entity) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        const codePoint = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
      }
      if (entity.startsWith('#')) {
        const codePoint = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
      }

      return HTML_ENTITY_MAP[entity.toLowerCase()] ?? match;
    });
    if (next === decoded) break;
    decoded = next;
  }

  return decoded;
}

export interface AccessiblePdfPageContent {
  index: number;
  markdownWithImages: string;
  dimensions?: {
    width?: number;
    height?: number;
    dpi?: number;
  };
}

type RenderMode = 'pdf' | 'sidecar';

type RenderedImageToken = {
  token: string;
  inlineHtml: string;
  blockHtml: string;
};

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

export interface RenderMarkdownOptions {
  minimumHeadingLevel?: number;
  renderMode?: RenderMode;
}

function sanitizeHref(rawHref: string): string {
  const href = rawHref.trim();
  if (!href) return '';
  if (/^(https?:|mailto:|tel:|#)/i.test(href)) return href;
  return '';
}

const GENERIC_IMAGE_ALT_TEXTS = new Set([
  'image',
  'img',
  'photo',
  'picture',
  'graphic',
  'diagram',
  'icon',
  'figure',
  'screenshot',
  'scan',
  'logo'
]);

const GENERIC_LINK_TEXTS = new Set([
  'click here',
  'here',
  'read more',
  'learn more',
  'more',
  'details',
  'link',
  'this',
  'visit',
  'open'
]);

function isPlaceholderImageAltText(value: string): boolean {
  const normalized = collapseWhitespace(value || '');
  if (!normalized) return true;

  const lowered = normalized.toLowerCase();
  if (GENERIC_IMAGE_ALT_TEXTS.has(lowered)) return true;

  const withoutExtension = lowered.replace(/\.[a-z0-9]{1,5}$/i, '');
  const relaxed = collapseWhitespace(withoutExtension.replace(/[_-]+/g, ' '));
  if (!relaxed) return true;
  if (GENERIC_IMAGE_ALT_TEXTS.has(relaxed)) return true;

  return /^(img|image|photo|picture|graphic|figure|diagram|illustration|scan|screenshot|page|pic|dsc|chart|table)\s*(?:[#-]?\s*\d+)?$/i.test(relaxed);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function truncateText(value: string, maxLength: number): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function stripMarkdownForTitle(value: string): string {
  if (!value) return '';
  return collapseWhitespace(
    decodeHtmlEntities(value)
      .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_~`>#]/g, ' ')
      .replace(/^\s*\d+\.\s+/g, '')
      .replace(/^\s*[-*+]\s+/g, '')
      .replace(/<[^>]+>/g, ' ')
  );
}

function extractDocumentTitleCandidate(source: string): string {
  if (!source) return '';
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (!heading) continue;
    const candidate = truncateText(stripMarkdownForTitle(heading[1]), 160);
    if (candidate.length >= 3) return candidate;
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^!\[[^\]]*]\([^)]+\)$/.test(trimmed)) continue;
    if (/^\|/.test(trimmed)) continue;
    if (/^(:?-{3,}:?\s*\|)+/.test(trimmed)) continue;
    const candidate = truncateText(stripMarkdownForTitle(trimmed), 160);
    if (candidate.length >= 3) return candidate;
  }

  return '';
}

function sanitizeProvidedExportTitle(value: string): string {
  const normalized = collapseWhitespace(decodeHtmlEntities(value || ''));
  if (!normalized) return '';
  const withoutOcrSuffix = normalized.replace(/\s+OCR$/i, '');
  const withoutExtension = withoutOcrSuffix.replace(/\.(pdf|png|jpe?g|tif|tiff|bmp|gif|webp)$/i, '');
  return collapseWhitespace(withoutExtension);
}

export function resolveAccessibleDocumentTitle(
  providedTitle: string,
  text: string,
  pages: AccessiblePdfPageContent[] = []
): string {
  for (const page of pages) {
    const candidate = extractDocumentTitleCandidate(page.markdownWithImages || '');
    if (candidate) return candidate;
  }

  const textCandidate = extractDocumentTitleCandidate(text || '');
  if (textCandidate) return textCandidate;

  const provided = sanitizeProvidedExportTitle(providedTitle);
  if (provided) return truncateText(provided, 160);

  return 'OCR Transcript';
}

function sanitizeImageSrc(rawSrc: string): string {
  const src = rawSrc.trim();
  if (!src) return '';
  if (/^javascript:/i.test(src)) return '';
  if (/^data:/i.test(src) && !/^data:image\//i.test(src)) return '';
  return src;
}

function buildReadableSourceName(rawSrc: string): string {
  const normalizedSrc = (rawSrc || '').trim().split(/[?#]/)[0] || '';
  if (!normalizedSrc) return '';
  const srcBase = path.basename(normalizedSrc, path.extname(normalizedSrc));
  const decoded = safeDecodeURIComponent(srcBase);
  const readable = collapseWhitespace(decoded.replace(/[_-]+/g, ' '));
  if (!readable) return '';
  if (isPlaceholderImageAltText(readable)) {
    return '';
  }
  return readable;
}

function buildImageAltText(rawAlt: string, rawSrc: string): string {
  const alt = collapseWhitespace(decodeHtmlEntities(rawAlt || ''));
  if (alt && !isPlaceholderImageAltText(alt)) {
    return truncateText(alt, 160);
  }

  const readable = buildReadableSourceName(rawSrc);
  if (readable) {
    return truncateText(`Image: ${readable}`, 160);
  }

  return 'Scanned document image';
}

export function sanitizeLanguageTag(rawLang: string): string {
  const lang = collapseWhitespace(rawLang || '');
  if (!lang) return 'en';
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(lang)) return 'en';
  return lang;
}

function buildLinkFallbackLabel(href: string): string {
  if (!href) return 'Link';
  if (/^mailto:/i.test(href)) return 'Email link';
  if (/^tel:/i.test(href)) return 'Phone link';
  if (href.startsWith('#')) {
    const target = collapseWhitespace(href.slice(1).replace(/[-_]+/g, ' '));
    return target ? `Jump to ${target}` : 'Jump link';
  }
  if (/^https?:/i.test(href)) {
    try {
      const url = new URL(href);
      const pathLabel = url.pathname && url.pathname !== '/' ? url.pathname : '';
      return `${url.hostname}${pathLabel}`;
    } catch {
      return href;
    }
  }
  return href;
}

function buildGenericLinkAriaLabel(href: string): string {
  const target = buildLinkFallbackLabel(href);
  return `Open link: ${target}`;
}

function normalizeTableRow(cells: string[], width: number): string[] {
  if (width <= 0) return [];
  const normalized = cells.slice(0, width);
  while (normalized.length < width) {
    normalized.push('');
  }
  return normalized;
}

function findUnescapedSequence(source: string, target: string, fromIndex: number): number {
  let idx = source.indexOf(target, fromIndex);
  while (idx !== -1) {
    if (idx === 0 || source[idx - 1] !== '\\') return idx;
    idx = source.indexOf(target, idx + target.length);
  }
  return -1;
}

function renderLatexMath(latexRaw: string, displayMode: boolean): string {
  const latex = decodeHtmlEntities(latexRaw).trim();
  if (!latex) return '';
  try {
    const mathMl = katex.renderToString(latex, {
      displayMode,
      output: 'mathml',
      throwOnError: true,
      strict: 'ignore',
      trust: false
    });
    if (displayMode) {
      return `<div class="ocr-math-display">${mathMl}</div>`;
    }
    return `<span class="ocr-math-inline">${mathMl}</span>`;
  } catch {
    const escaped = escapeHtml(latex);
    if (displayMode) {
      return `<pre class="ocr-math-fallback">${escaped}</pre>`;
    }
    return `<code class="ocr-math-fallback">${escaped}</code>`;
  }
}

function tokenizeInlineMath(raw: string): { text: string; tokens: Array<{ token: string; html: string }> } {
  const tokens: Array<{ token: string; html: string }> = [];
  if (!raw) return { text: '', tokens };

  const pushToken = (latex: string, displayMode: boolean): string => {
    const token = `@@OCRMATHTOKEN${tokens.length}@@`;
    tokens.push({ token, html: renderLatexMath(latex, displayMode) });
    return token;
  };

  const findInlineDollarClose = (source: string, fromIndex: number): number => {
    for (let idx = fromIndex; idx < source.length; idx++) {
      if (source[idx] !== '$') continue;
      if (source[idx - 1] === '\\') continue;
      if (source[idx + 1] === '$') continue;
      const before = source[idx - 1] || '';
      const after = source[idx + 1] || '';
      if (/\s/.test(before)) continue;
      if (/\d/.test(after)) continue;
      return idx;
    }
    return -1;
  };

  let result = '';
  let i = 0;

  while (i < raw.length) {
    if (raw[i] === '`') {
      const close = raw.indexOf('`', i + 1);
      if (close !== -1) {
        result += raw.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }

    if (raw.startsWith('\\(', i)) {
      const close = findUnescapedSequence(raw, '\\)', i + 2);
      if (close !== -1) {
        const latex = raw.slice(i + 2, close);
        if (latex.trim()) {
          result += pushToken(latex, false);
          i = close + 2;
          continue;
        }
      }
    }

    if (raw.startsWith('$$', i)) {
      const close = findUnescapedSequence(raw, '$$', i + 2);
      if (close !== -1) {
        const latex = raw.slice(i + 2, close);
        if (latex.trim()) {
          result += pushToken(latex, false);
          i = close + 2;
          continue;
        }
      }
    }

    if (raw[i] === '$' && raw[i - 1] !== '\\' && raw[i + 1] !== '$') {
      const next = raw[i + 1] || '';
      if (next && !/\s/.test(next)) {
        const close = findInlineDollarClose(raw, i + 1);
        if (close !== -1) {
          const latex = raw.slice(i + 1, close);
          if (latex.trim()) {
            result += pushToken(latex, false);
            i = close + 1;
            continue;
          }
        }
      }
    }

    result += raw[i];
    i += 1;
  }

  return { text: result, tokens };
}

function renderInlineMarkdown(
  raw: string,
  imageTokens: RenderedImageToken[]
): string {
  if (!raw) return '';
  const { text: mathTokenizedText, tokens: mathTokens } = tokenizeInlineMath(raw);
  let html = escapeHtml(mathTokenizedText);

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  html = html.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1<em>$2</em>');
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, labelRaw, hrefRaw) => {
    const sanitizedHref = sanitizeHref(String(hrefRaw || ''));
    const safeHref = escapeHtml(sanitizedHref);
    const label = collapseWhitespace(String(labelRaw || ''));
    const normalizedLabel = label.toLowerCase();
    const resolvedLabel = label || escapeHtml(buildLinkFallbackLabel(sanitizedHref));
    if (!safeHref) return label;
    const rel = /^https?:/i.test(sanitizedHref) ? ' rel="noopener noreferrer"' : '';
    const ariaLabel = GENERIC_LINK_TEXTS.has(normalizedLabel) || !label
      ? ` aria-label="${escapeHtml(buildGenericLinkAriaLabel(sanitizedHref))}"`
      : '';
    return `<a href="${safeHref}"${rel}${ariaLabel}>${resolvedLabel}</a>`;
  });

  for (const img of imageTokens) {
    html = html.split(img.token).join(img.inlineHtml);
  }
  for (const mathToken of mathTokens) {
    html = html.split(mathToken.token).join(mathToken.html);
  }

  return html;
}

function normalizeBareOcrLatex(fragment: string): string {
  return fragment
    .replace(/[−–—]/g, '-')
    .replace(/×/g, '\\times ')
    .replace(/÷/g, '\\div ')
    .replace(/·/g, '\\cdot ')
    .replace(/\s+/g, ' ')
    .trim();
}

function prepareTableCellInlineMarkdown(raw: string): string {
  if (!raw || !/(\^\{[^}\n]+\}|_\{[^}\n]+\})/.test(raw)) return raw;

  const protectedSegmentsPattern = /(`[^`]*`|\\\([^]*?\\\)|\\\[[^]*?\\\]|\$\$[^]*?\$\$|\$[^$\n]+\$)/g;
  const bareLatexPattern = /(^|[\s|[(])([^\s|`$]*?(?:\^\{[^}\n]+\}|_\{[^}\n]+\})[^\s|`$]*)(?=$|[\s|,.;:)\]])/g;

  return raw
    .split(protectedSegmentsPattern)
    .map((segment, idx) => {
      if (idx % 2 === 1) return segment;
      return segment.replace(bareLatexPattern, (_match, prefix, fragment) => {
        const normalized = normalizeBareOcrLatex(String(fragment || ''));
        if (!normalized) return String(prefix || '');
        return `${String(prefix || '')}$${normalized}$`;
      });
    })
    .join('');
}

function parseTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(cell => cell.trim());
}

function renderMarkdownLikeHtml(
  markdown: string,
  minimumHeadingLevelOrOptions: number | RenderMarkdownOptions = 2
): string {
  if (!markdown) return '';
  const options = typeof minimumHeadingLevelOrOptions === 'number'
    ? { minimumHeadingLevel: minimumHeadingLevelOrOptions }
    : minimumHeadingLevelOrOptions;
  const renderMode: RenderMode = options.renderMode ?? 'pdf';

  type ParsedListItem = {
    html: string;
    explicitValue?: number;
  };

  const imageTokens: RenderedImageToken[] = [];
  let tokenized = decodeHtmlEntities(markdown);
  let imageIndex = 0;
  tokenized = tokenized.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_full, altRaw, srcRaw, titleRaw) => {
    const token = `@@OCRIMGTOKEN${imageIndex++}@@`;
    const sourceAlt = collapseWhitespace(String(altRaw || ''));
    const normalizedAlt = buildImageAltText(sourceAlt, String(srcRaw || ''));
    const alt = escapeHtmlAttribute(normalizedAlt);
    const title = collapseWhitespace(decodeHtmlEntities(String(titleRaw || '')));
    const captionText = title && title.toLowerCase() !== normalizedAlt.toLowerCase()
      ? truncateText(title, 320)
      : '';
    const sanitizedSrc = sanitizeImageSrc(String(srcRaw || ''));
    if (!sanitizedSrc) {
      imageTokens.push({
        token,
        inlineHtml: '<span class="ocr-image-note">Image omitted: unsupported source.</span>',
        blockHtml: '<p class="ocr-image-note">Image omitted: unsupported source.</p>'
      });
      return token;
    }
    const src = escapeHtml(sanitizedSrc);
    const accessibleDescription = captionText || normalizedAlt;
    const ariaLabel = escapeHtmlAttribute(accessibleDescription);
    const titleAttr = captionText ? ` title="${escapeHtmlAttribute(captionText)}"` : '';
    const inlineHtml = `<img class="ocr-inline-image" src="${src}" alt="${alt}" aria-label="${ariaLabel}"${titleAttr} />`;
    const blockHtml = renderMode === 'sidecar'
      ? `<div class="ocr-figure">${inlineHtml}${captionText ? `<p class="ocr-figure-caption">${escapeHtml(captionText)}</p>` : ''}</div>`
      : inlineHtml;
    imageTokens.push({
      token,
      inlineHtml,
      blockHtml
    });
    return token;
  });
  const imageTokenMap = new Map(imageTokens.map(token => [token.token, token]));

  const lines = tokenized.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let paragraphLines: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let listItems: ParsedListItem[] = [];
  let listHadBlankGap = false;
  let lastHeadingText = '';
  let tableCount = 0;
  const normalizedMinimumHeadingLevel = Math.max(1, Math.min(6, options.minimumHeadingLevel ?? 2));
  let headingOffset: number | null = null;
  let previousHeadingLevel: number | null = null;
  const imageTokenForLine = (line: string): RenderedImageToken | undefined => imageTokenMap.get(line.trim());

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    if (renderMode === 'sidecar') {
      const blockImages = paragraphLines
        .map(line => imageTokenForLine(line))
        .filter((token): token is RenderedImageToken => Boolean(token));
      if (blockImages.length === paragraphLines.length && blockImages.length > 0) {
        blocks.push(blockImages.map(token => token.blockHtml).join(''));
        paragraphLines = [];
        return;
      }
    }
    const content = paragraphLines.map(line => renderInlineMarkdown(line, imageTokens)).join('<br/>');
    blocks.push(`<p>${content}</p>`);
    paragraphLines = [];
  };

  const flushList = () => {
    if (!listType || !listItems.length) {
      listType = null;
      listItems = [];
      listHadBlankGap = false;
      return;
    }
    if (listType === 'ol') {
      const itemsHtml = listItems.map(item => {
        const valueAttr = item.explicitValue !== undefined ? ` value="${item.explicitValue}"` : '';
        return `<li${valueAttr}>${item.html}</li>`;
      }).join('');
      blocks.push(`<ol class="ocr-ordered-list">${itemsHtml}</ol>`);
    } else {
      blocks.push(`<ul class="ocr-unordered-list">${listItems.map(item => `<li>${item.html}</li>`).join('')}</ul>`);
    }
    listType = null;
    listItems = [];
    listHadBlankGap = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      if (listType) {
        listHadBlankGap = true;
      } else {
        flushList();
      }
      continue;
    }

    const mathFence = trimmed.match(/^(```|~~~)\s*(math|latex)\s*$/i);
    if (mathFence) {
      flushParagraph();
      flushList();
      const fenceToken = mathFence[1];
      const mathLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fenceToken)) {
        mathLines.push(lines[i]);
        i += 1;
      }
      const blockHtml = renderLatexMath(mathLines.join('\n'), true);
      if (blockHtml) blocks.push(blockHtml);
      continue;
    }

    if (trimmed.startsWith('$$')) {
      const singleLineInline = trimmed.length > 4 && trimmed.endsWith('$$');
      if (singleLineInline) {
        flushParagraph();
        flushList();
        const blockHtml = renderLatexMath(trimmed.slice(2, -2), true);
        if (blockHtml) blocks.push(blockHtml);
        continue;
      }

      const collected: string[] = [];
      const startContent = line.slice(line.indexOf('$$') + 2);
      if (startContent.trim()) collected.push(startContent);
      let endIndex = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const closeAt = lines[j].indexOf('$$');
        if (closeAt !== -1) {
          const beforeClose = lines[j].slice(0, closeAt);
          if (beforeClose.trim()) collected.push(beforeClose);
          endIndex = j;
          break;
        }
        collected.push(lines[j]);
      }
      if (endIndex !== -1) {
        flushParagraph();
        flushList();
        const blockHtml = renderLatexMath(collected.join('\n'), true);
        if (blockHtml) blocks.push(blockHtml);
        i = endIndex;
        continue;
      }
    }

    if (trimmed.startsWith('\\[')) {
      const openIndex = line.indexOf('\\[');
      const sameLineClose = line.indexOf('\\]', openIndex + 2);
      if (sameLineClose !== -1) {
        flushParagraph();
        flushList();
        const blockHtml = renderLatexMath(line.slice(openIndex + 2, sameLineClose), true);
        if (blockHtml) blocks.push(blockHtml);
        continue;
      }

      const collected: string[] = [];
      const startContent = line.slice(openIndex + 2);
      if (startContent.trim()) collected.push(startContent);
      let endIndex = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const closeAt = lines[j].indexOf('\\]');
        if (closeAt !== -1) {
          const beforeClose = lines[j].slice(0, closeAt);
          if (beforeClose.trim()) collected.push(beforeClose);
          endIndex = j;
          break;
        }
        collected.push(lines[j]);
      }
      if (endIndex !== -1) {
        flushParagraph();
        flushList();
        const blockHtml = renderLatexMath(collected.join('\n'), true);
        if (blockHtml) blocks.push(blockHtml);
        i = endIndex;
        continue;
      }
    }

    const fence = trimmed.match(/^(```|~~~)/);
    if (fence) {
      flushParagraph();
      flushList();
      const fenceToken = fence[1];
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fenceToken)) {
        codeLines.push(lines[i]);
        i += 1;
      }
      blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      flushList();
      // Skip decorative horizontal rules to avoid untagged drawing artifacts in PDF output.
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const rawLevel = heading[1].length;
      if (headingOffset === null) {
        headingOffset = normalizedMinimumHeadingLevel - rawLevel;
      }
      let level = Math.max(
        normalizedMinimumHeadingLevel,
        Math.min(6, rawLevel + headingOffset)
      );
      if (previousHeadingLevel !== null) {
        if (level > previousHeadingLevel + 1) {
          level = previousHeadingLevel + 1;
        } else if (level < previousHeadingLevel - 1) {
          level = previousHeadingLevel - 1;
        }
      }
      previousHeadingLevel = level;
      lastHeadingText = heading[2].trim();
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2], imageTokens)}</h${level}>`);
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushParagraph();
      flushList();
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      i -= 1;
      const quoteHtml = quoteLines.map(q => renderInlineMarkdown(q, imageTokens)).join('<br/>');
      blocks.push(`<blockquote>${quoteHtml}</blockquote>`);
      continue;
    }

    const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
    const isTableSeparator = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(nextLine);
    if (trimmed.includes('|') && isTableSeparator) {
      flushParagraph();
      flushList();
      const headerCells = parseTableCells(trimmed);
      const rowEntries: Array<{ raw: string; cells: string[] }> = [];
      i += 2;
      while (i < lines.length) {
        const rowLine = lines[i].trim();
        if (!rowLine || !rowLine.includes('|')) {
          i -= 1;
          break;
        }
        rowEntries.push({ raw: rowLine, cells: parseTableCells(rowLine) });
        i += 1;
      }
      const rows = rowEntries.map(entry => entry.cells);
      const expectedColumnCount = headerCells.length;
      const isStructurallyRegular = expectedColumnCount >= 2
        && rows.length > 0
        && rows.every(row => row.length === expectedColumnCount);
      if (!isStructurallyRegular) {
        const rawTableLines = [trimmed, nextLine, ...rowEntries.map(entry => entry.raw)];
        blocks.push(`<pre><code>${escapeHtml(rawTableLines.join('\n'))}</code></pre>`);
        continue;
      }
      const normalizedHeaders = normalizeTableRow(headerCells, expectedColumnCount);
      const normalizedRows = rows.map(row => normalizeTableRow(row, expectedColumnCount));
      tableCount += 1;
      const tableId = `ocr-table-${tableCount}`;
      const captionBase = lastHeadingText || `Table ${tableCount}`;
      const captionText = lastHeadingText ? `Table ${tableCount}: ${captionBase}` : captionBase;
      const summaryText = `Data table with ${expectedColumnCount} columns and ${normalizedRows.length} rows.`;
      const headerIds = normalizedHeaders.map((_cell, colIdx) => `${tableId}-col-${colIdx + 1}`);
      const captionHtml = `<caption id="${tableId}-caption">${escapeHtml(captionText)}</caption>`;
      const headHtml = `<tr>${normalizedHeaders.map((cell, colIdx) => {
        const headerContent = cell
          ? renderInlineMarkdown(prepareTableCellInlineMarkdown(cell), imageTokens)
          : `Column ${colIdx + 1}`;
        return `<th id="${headerIds[colIdx]}" scope="col">${headerContent}</th>`;
      }).join('')}</tr>`;
      const bodyHtml = normalizedRows.map(row =>
        `<tr>${row.map((cell, colIdx) => `<td headers="${headerIds[colIdx]}">${renderInlineMarkdown(prepareTableCellInlineMarkdown(cell), imageTokens)}</td>`).join('')}</tr>`
      ).join('');
      blocks.push(`<table aria-describedby="${tableId}-caption" summary="${escapeHtml(summaryText)}">${captionHtml}<thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table>`);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (unordered || ordered) {
      const nextType: 'ul' | 'ol' = unordered ? 'ul' : 'ol';
      flushParagraph();
      if (listType && listType !== nextType) {
        flushList();
      }
      if (!listType) {
        listType = nextType;
      }
      if (unordered) {
        listItems.push({ html: renderInlineMarkdown(unordered[1] || '', imageTokens) });
      } else if (ordered) {
        const explicitValue = Number.parseInt(ordered[1], 10);
        listItems.push({
          html: renderInlineMarkdown(ordered[2] || '', imageTokens),
          explicitValue: Number.isFinite(explicitValue) ? explicitValue : undefined
        });
      }
      listHadBlankGap = false;
      continue;
    }

    if (listType && listItems.length) {
      if (!listHadBlankGap) {
        const continuation = renderInlineMarkdown(trimmed, imageTokens);
        listItems[listItems.length - 1].html = `${listItems[listItems.length - 1].html}<br/>${continuation}`;
        continue;
      }
      flushList();
    }
    paragraphLines.push(trimmed);
  }

  flushParagraph();
  flushList();
  return blocks.join('');
}

// ============================================================================
// Moved verbatim from mistralImage.ts: embedImagesIntoMarkdown and its
// helpers (image annotation / data-URI plumbing).
// ============================================================================

function inferImageMimeFromId(id: string): string {
  const ext = path.extname(id).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    default:
      return 'image/jpeg';
  }
}

function normalizeDataUri(imageBase64: string, id: string): string {
  const raw = imageBase64.trim();
  if (!raw) return '';
  if (raw.startsWith('data:')) return raw;
  return `data:${inferImageMimeFromId(id)};base64,${raw}`;
}

function sanitizeMarkdownAltText(value: string): string {
  return collapseWhitespace(value || '').replace(/[\r\n[\]]+/g, ' ').trim();
}

function sanitizeMarkdownTitleText(value: string): string {
  return collapseWhitespace(value || '').replace(/[\r\n"]+/g, ' ').trim();
}

function isPlaceholderImageLabel(value: string): boolean {
  const normalized = collapseWhitespace(value || '');
  if (!normalized) return true;

  const lowered = normalized.toLowerCase();
  const withoutExtension = lowered.replace(/\.[a-z0-9]{1,5}$/i, '');
  const relaxed = collapseWhitespace(withoutExtension.replace(/[_-]+/g, ' '));
  if (!relaxed) return true;

  return /^(img|image|photo|picture|graphic|figure|diagram|illustration|scan|screenshot|page|pic|dsc|chart|table)\s*(?:[#-]?\s*\d+)?$/i.test(relaxed);
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = collapseWhitespace(value);
    if (trimmed) return trimmed;
  }
  return '';
}

function normalizeImageAnnotationPayload(annotation: unknown): unknown {
  if (typeof annotation === 'string') {
    const trimmed = annotation.trim();
    if (!trimmed) return '';
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return normalizeImageAnnotationPayload(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }

  if (!annotation || typeof annotation !== 'object') {
    return annotation;
  }

  const candidate = annotation as Record<string, unknown>;
  const nested = candidate.parsed ?? candidate.value ?? candidate.json ?? candidate.data ?? candidate.content;
  if (nested !== undefined && nested !== annotation) {
    return normalizeImageAnnotationPayload(nested);
  }

  return annotation;
}

function extractImageAnnotationData(image: any): { altText: string; summary: string } {
  const annotation = normalizeImageAnnotationPayload(
    image?.image_annotation ?? image?.bbox_annotation ?? image?.annotation
  );
  if (!annotation) {
    return { altText: '', summary: '' };
  }

  if (typeof annotation === 'string') {
    const text = collapseWhitespace(annotation);
    return { altText: text, summary: text };
  }

  if (typeof annotation !== 'object') {
    return { altText: '', summary: '' };
  }

  const annotationRecord = annotation as Record<string, unknown>;
  const altText = firstNonEmptyString(
    annotationRecord.short_description,
    annotationRecord.shortDescription,
    annotationRecord.alt_text,
    annotationRecord.altText,
    annotationRecord.description,
    annotationRecord.caption,
    annotationRecord.title,
    annotationRecord.label,
    annotationRecord.image_type,
    annotationRecord.imageType
  );
  const summary = firstNonEmptyString(
    annotationRecord.summary,
    annotationRecord.long_description,
    annotationRecord.longDescription,
    annotationRecord.explanation
  );
  return { altText, summary };
}

type EmbeddedImageInfo = {
  uri: string;
  altText: string;
  summary: string;
};

function buildImageDataMap(images: any[]): Map<string, EmbeddedImageInfo> {
  const map = new Map<string, EmbeddedImageInfo>();
  for (const img of images) {
    if (!img || typeof img !== 'object') continue;
    const id = typeof img.id === 'string' ? img.id.trim() : '';
    const base64 = typeof img.image_base64 === 'string'
      ? img.image_base64
      : (typeof img.imageBase64 === 'string' ? img.imageBase64 : '');
    if (!id || !base64) continue;
    const uri = normalizeDataUri(base64, id);
    if (!uri) continue;
    const annotation = extractImageAnnotationData(img);
    const entry: EmbeddedImageInfo = {
      uri,
      altText: annotation.altText,
      summary: annotation.summary
    };
    map.set(id, entry);
    map.set(path.basename(id), entry);
  }
  return map;
}

function embedImagesIntoMarkdown(markdown: string, pageImages: any[]): string {
  if (!markdown) return '';
  if (!Array.isArray(pageImages) || pageImages.length === 0) return markdown;

  const imageMap = buildImageDataMap(pageImages);
  if (!imageMap.size) return markdown;

  return markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (full, alt, srcRaw) => {
    const src = String(srcRaw || '').trim();
    const decodedSrc = safeDecodeURIComponent(src);
    const candidateKeys = [
      src,
      decodedSrc,
      path.basename(src),
      path.basename(decodedSrc)
    ];
    for (const key of candidateKeys) {
      const value = imageMap.get(key);
      if (value) {
        const existingAlt = sanitizeMarkdownAltText(String(alt || ''));
        const annotationAlt = sanitizeMarkdownAltText(value.altText);
        const nextAlt = (!isPlaceholderImageLabel(existingAlt) ? existingAlt : annotationAlt) || existingAlt;
        const safeAlt = sanitizeMarkdownAltText(nextAlt);
        const safeTitle = sanitizeMarkdownTitleText(value.summary);
        if (safeTitle) {
          return `![${safeAlt}](${value.uri} "${safeTitle}")`;
        }
        return `![${safeAlt}](${value.uri})`;
      }
    }
    return full;
  });
}

// ============================================================================
// Moved verbatim from mistralImage.ts: cleanMarkdown.
// ============================================================================

function cleanMarkdown(text: string): string {
  if (!text) return '';
  let cleaned = text;

  // Drop code fences and their contents
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/~~~[\s\S]*?~~~/g, '');
  // Drop images entirely
  cleaned = cleaned.replace(/!\[[^\]]*]\([^)]+\)/g, '');
  // Links -> keep the label
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Headers
  cleaned = cleaned.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  // Blockquotes
  cleaned = cleaned.replace(/^\s{0,3}>\s?/gm, '');
  // Lists (bullets and numbered)
  cleaned = cleaned.replace(/^\s*[-*+]\s+/gm, '');
  cleaned = cleaned.replace(/^\s*\d+\.\s+/gm, '');
  // Tables: drop header separators and outer pipes
  cleaned = cleaned.replace(/^\s*\|?\s*:?-{2,}.*\n?/gm, '');
  cleaned = cleaned.replace(/^\s*\|([^|]+(?:\|[^|]+)+)\|\s*$/gm, (_m, row: string) => {
    return row
      .split('|')
      .map((cell: string) => cell.trim())
      .filter(Boolean)
      .join('  ');
  });
  // Footnote markers and definitions
  cleaned = cleaned.replace(/\[\^[^\]]+]\s*/g, '');
  cleaned = cleaned.replace(/^\s*\[\^[^\]]+]:.*$/gm, '');
  // Simple LaTeX-ish superscripts like ${ }^{34}$
  cleaned = cleaned.replace(/\$\s*\{\s*\}\^\{(\d+)\}\$/g, '$1');
  // Inline math and display math: drop delimiters, keep inner text — but
  // only when it actually looks like math (has a LaTeX command or exponent).
  // Otherwise two unrelated currency amounts on the same page (e.g. "$100"
  // on one line, "$250" on another) pair up as fake delimiters and silently
  // lose their "$", which then no longer matches the OCR word's own text.
  const looksLikeMath = (inner: string) => /[\\^_]/.test(inner);
  cleaned = cleaned.replace(/\$\$([\s\S]*?)\$\$/g, (m, inner) => looksLikeMath(inner) ? inner : m);
  cleaned = cleaned.replace(/\$([^$]+)\$/g, (m, inner) => looksLikeMath(inner) ? inner : m);
  // Strip HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  // Strip basic markdown emphasis/inline code markers
  cleaned = cleaned.replace(/[*_`~]+/g, '');
  // Collapse excess whitespace
  cleaned = cleaned.replace(/[ \t]+\n/g, '\n');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
  return cleaned.trim();
}

// ============================================================================
// Worker-thread entry point. Only runs inside the spawned worker thread
// (see getSharedWorker() below) -- when this module is imported normally by
// main.ts/mistralImage.ts, isMainThread is true and none of this executes.
// ============================================================================

type MarkdownWorkerOp = 'renderMarkdownLikeHtml' | 'embedImagesIntoMarkdown' | 'cleanMarkdown';

interface MarkdownWorkerRequest {
  id: number;
  op: MarkdownWorkerOp;
  args: unknown[];
}

interface MarkdownWorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
}

function runMarkdownWorkerOp(request: MarkdownWorkerRequest): unknown {
  switch (request.op) {
    case 'renderMarkdownLikeHtml':
      return renderMarkdownLikeHtml(
        request.args[0] as string,
        request.args[1] as number | RenderMarkdownOptions
      );
    case 'embedImagesIntoMarkdown':
      return embedImagesIntoMarkdown(request.args[0] as string, request.args[1] as any[]);
    case 'cleanMarkdown':
      return cleanMarkdown(request.args[0] as string);
    default:
      throw new Error(`Unknown markdown worker op: ${String((request as { op: unknown }).op)}`);
  }
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on('message', (request: MarkdownWorkerRequest) => {
    try {
      const result = runMarkdownWorkerOp(request);
      port.postMessage({ id: request.id, result } satisfies MarkdownWorkerResponse);
    } catch (err) {
      port.postMessage({ id: request.id, error: err instanceof Error ? err.message : String(err) } satisfies MarkdownWorkerResponse);
    }
  });
}

// ============================================================================
// Main-thread client. Lazily spawns a single shared worker (never more than
// one at a time) and reuses it across every call from both main.ts and
// mistralImage.ts. Each op is a plain synchronous function call inside the
// 'message' handler above, so ordinarily responses come back in send order --
// but callers aren't necessarily sequential (e.g. concurrent test runs), and
// the worker gets torn down once idle (see getSharedWorker() below), so a new
// generation can start while an old one is still finishing. Matching by
// request id instead of FIFO position keeps that safe: a response can never
// resolve the wrong caller's promise, regardless of which worker generation
// handled it or what order responses arrive in.
// ============================================================================

let sharedWorker: Worker | null = null;
let nextRequestId = 0;
const pendingCallbacks = new Map<number, { resolve: (value: unknown) => void; reject: (err: unknown) => void }>();

function failAllPending(err: unknown): void {
  for (const callback of pendingCallbacks.values()) callback.reject(err);
  pendingCallbacks.clear();
}

function getSharedWorker(): Worker {
  if (sharedWorker) return sharedWorker;

  const worker = new Worker(new URL(import.meta.url));
  // worker.unref() alone doesn't reliably let the process exit -- Node keeps
  // an internal MessagePort handle alive as long as the Worker instance
  // exists, unref or not. So once a burst of calls drains to zero pending,
  // terminate the worker outright instead of keeping it "warm" -- markdown
  // rendering isn't a hot path (once per export action), so respawning on
  // the next call is cheap, and this guarantees Electron/a plain script/test
  // can always exit right after its last render call settles.
  //
  // worker.terminate() itself fires 'exit', asynchronously, some time after
  // this call returns -- by then a *newer* generation may already be handling
  // its own in-flight request. `retiredDeliberately` distinguishes "this exact
  // worker was retired on purpose, ignore its exit" from "this worker died
  // unexpectedly (crash), fail whatever it was working on" -- checking
  // `sharedWorker === worker` alone isn't enough, since that pointer may have
  // already moved on to a newer generation for either reason by the time
  // 'exit' fires.
  let retiredDeliberately = false;
  worker.unref();
  worker.on('message', (response: MarkdownWorkerResponse) => {
    const callback = pendingCallbacks.get(response.id);
    pendingCallbacks.delete(response.id);
    if (pendingCallbacks.size === 0 && sharedWorker === worker) {
      sharedWorker = null;
      retiredDeliberately = true;
      worker.terminate();
    }
    if (!callback) return;
    if (response.error) callback.reject(new Error(response.error));
    else callback.resolve(response.result);
  });
  worker.on('error', (err) => {
    if (sharedWorker === worker) sharedWorker = null;
    failAllPending(err);
  });
  worker.on('exit', (code) => {
    if (sharedWorker === worker) sharedWorker = null;
    if (!retiredDeliberately && pendingCallbacks.size) {
      failAllPending(new Error(`markdown render worker exited unexpectedly with code ${code}`));
    }
  });

  sharedWorker = worker;
  return worker;
}

export function callMarkdownWorker<T = unknown>(op: MarkdownWorkerOp, args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextRequestId++;
    pendingCallbacks.set(id, { resolve: resolve as (value: unknown) => void, reject });
    getSharedWorker().postMessage({ id, op, args } satisfies MarkdownWorkerRequest);
  });
}
