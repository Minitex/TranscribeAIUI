import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

let currentController: AbortController | null = null;
let currentReject: ((err: any) => void) | null = null;

const SUPPORTED_EXTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.jp2', '.tif', '.tiff', '.bmp', '.gif']);
const MAX_ERROR_SNIPPET = 500;

function sanitizeMistralErrorText(errText: string): string {
  if (!errText) return '';
  const trimmed = errText.trim();
  if (!trimmed) return '';
  const scrubbed = trimmed.replace(/[A-Za-z0-9+/=]{200,}/g, '[base64 omitted]');
  if (scrubbed.length <= MAX_ERROR_SNIPPET) return scrubbed;
  return `${scrubbed.slice(0, MAX_ERROR_SNIPPET)}…`;
}

function abortError() {
  const err: any = new Error('terminated by user');
  err.cancelled = true;
  return err;
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.jp2': return 'image/jp2';
    case '.tif':
    case '.tiff': return 'image/tiff';
    case '.bmp': return 'image/bmp';
    case '.gif': return 'image/gif';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

export function cancelMistralRequest() {
  if (currentController) {
    currentController.abort();
    currentController = null;
  }
  if (currentReject) {
    const rej = currentReject;
    currentReject = null;
    const err: any = new Error('terminated by user');
    err.cancelled = true;
    rej(err);
  }
}

export function isMistralSupported(filePath: string): boolean {
  return SUPPORTED_EXTS.has(path.extname(filePath).toLowerCase());
}

function normalizeCustomId(filePath: string, baseInput: string): string {
  const absBase = path.resolve(baseInput);
  const absFile = path.resolve(filePath);
  if (fs.existsSync(absBase) && fs.statSync(absBase).isFile()) {
    return path.basename(absFile);
  }
  const rel = path.relative(absBase, absFile);
  return rel.split(path.sep).join('/');
}

export interface MistralOcrPageDimensions {
  dpi?: number;
  width?: number;
  height?: number;
}

export interface MistralOcrPageResult {
  index: number;
  markdown: string;
  markdownWithImages: string;
  dimensions: MistralOcrPageDimensions;
}

export interface MistralOcrResult {
  text: string;
  pages: MistralOcrPageResult[];
}

const ACCESSIBLE_IMAGE_ANNOTATION_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'transcribeai_image_annotation',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image_type: {
          type: 'string',
          description: 'The type of image, such as portrait, chart, diagram, logo, or illustration.'
        },
        short_description: {
          type: 'string',
          description: 'A concise English description suitable for HTML alt text. Mention essential visible content only.'
        },
        summary: {
          type: 'string',
          description: 'A brief one or two sentence English summary of the image content and purpose.'
        }
      },
      required: ['image_type', 'short_description', 'summary']
    }
  }
} as const;

function normalizeNumber(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : undefined;
}

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

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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

function extractMarkdownSections(payload: any): string[] {
  const sections: string[] = [];
  const visit = (node: any) => {
    if (!node) return;
    if (typeof node === 'string') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === 'object') {
      if (typeof node.markdown === 'string') {
        sections.push(node.markdown);
      }
      Object.values(node).forEach(visit);
    }
  };
  visit(payload);
  return sections;
}

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
  // Inline math and display math: drop delimiters, keep inner text
  cleaned = cleaned.replace(/\$\$([\s\S]*?)\$\$/g, '$1');
  cleaned = cleaned.replace(/\$([^$]+)\$/g, '$1');
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

function parseOcrPayload(payload: any): MistralOcrResult {
  const rawPages = Array.isArray(payload?.pages) ? payload.pages : [];
  const pages: MistralOcrPageResult[] = [];
  const parts: string[] = [];

  if (rawPages.length > 0) {
    for (let i = 0; i < rawPages.length; i++) {
      const page = rawPages[i];
      const markdown = (page && typeof page.markdown === 'string')
        ? page.markdown.trim()
        : '';
      const images = Array.isArray(page?.images) ? page.images : [];
      const markdownWithImages = embedImagesIntoMarkdown(markdown, images);
      const text = cleanMarkdown(markdown);
      if (text) parts.push(text);
      pages.push({
        index: i + 1,
        markdown,
        markdownWithImages,
        dimensions: {
          dpi: normalizeNumber(page?.dimensions?.dpi),
          width: normalizeNumber(page?.dimensions?.width),
          height: normalizeNumber(page?.dimensions?.height)
        }
      });
    }
    return { text: parts.join('\n\n').trim(), pages };
  }

  // Fallback for unexpected payload shapes.
  const sections = extractMarkdownSections(payload);
  for (let i = 0; i < sections.length; i++) {
    const markdown = typeof sections[i] === 'string' ? sections[i].trim() : '';
    if (!markdown) continue;
    const text = cleanMarkdown(markdown);
    if (text) parts.push(text);
    pages.push({
      index: i + 1,
      markdown,
      markdownWithImages: markdown,
      dimensions: {}
    });
  }

  return { text: parts.join('\n\n').trim(), pages };
}

const MAX_DIMENSION = 4096;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB threshold to re-encode
const JPEG_QUALITY_STEPS = [90, 82, 74, 66];

async function convertImageToJpegWithSips(inputPath: string, outputPath: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('sharp preprocessing failed and sips is only available on macOS');
  }

  await new Promise<void>((resolve, reject) => {
    execFile(
      '/usr/bin/sips',
      [
        '-s', 'format', 'jpeg',
        '--resampleHeightWidthMax', String(MAX_DIMENSION),
        inputPath,
        '--out', outputPath
      ],
      { timeout: 120000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || stdout || error.message).trim() || 'sips failed'));
          return;
        }
        resolve();
      }
    );
  });
}

type MistralPreprocessResult = {
  path: string;
  mime: string;
  cleanup: (() => Promise<void>) | null;
  cacheStatus: 'none' | 'hit' | 'created';
};

function buildCachedMistralPath(
  filePath: string,
  outputExt: string,
  cacheDir?: string,
  baseInput?: string,
  tempRoot?: string
): string {
  const baseTemp = tempRoot || os.tmpdir();
  let outDir = cacheDir || baseTemp;
  if (cacheDir && baseInput) {
    const rel = path.relative(path.resolve(baseInput), path.resolve(filePath));
    outDir = path.join(cacheDir, path.dirname(rel));
  }
  return path.join(outDir, `${path.basename(filePath, path.extname(filePath))}${outputExt}`);
}

async function writeOptimizedJpeg(
  inputPath: string,
  outputPath: string,
  resize: boolean
): Promise<void> {
  const sharpMod = await import('sharp');
  const sharp = sharpMod?.default ?? sharpMod;
  for (let idx = 0; idx < JPEG_QUALITY_STEPS.length; idx++) {
    const quality = JPEG_QUALITY_STEPS[idx];
    let pipeline = sharp(inputPath, { failOnError: false, limitInputPixels: false });
    if (resize) {
      pipeline = pipeline.resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true
      });
    }
    await pipeline
      .jpeg({
        quality,
        mozjpeg: true
      })
      .toFile(outputPath);

    const written = await fs.promises.stat(outputPath).catch(() => null);
    if (!written || written.size <= MAX_FILE_BYTES || idx === JPEG_QUALITY_STEPS.length - 1) {
      return;
    }
  }
}

async function preprocessForMistral(
  filePath: string,
  cacheDir?: string,
  baseInput?: string,
  tempRoot?: string
): Promise<MistralPreprocessResult> {
  const ext = path.extname(filePath).toLowerCase();
  const requiresCompatibleUpload = ext === '.jp2';
  // PDFs pass through untouched
  if (ext === '.pdf') {
    return { path: filePath, mime: mimeFor(filePath), cleanup: null, cacheStatus: 'none' };
  }

  const mime = mimeFor(filePath);
  let sharpMod: any;
  try {
    sharpMod = await import('sharp');
  } catch {
    sharpMod = null;
  }
  const sharp = sharpMod?.default ?? sharpMod;

  const inputStat = await fs.promises.stat(filePath);
  let needsResize = false;
  if (sharp) {
    try {
      const meta = await sharp(filePath, { failOnError: false, limitInputPixels: false }).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      needsResize = width > MAX_DIMENSION || height > MAX_DIMENSION;
    } catch {
      needsResize = false;
    }
  }
  const needsReencode = requiresCompatibleUpload || ext === '.tif' || ext === '.tiff' || inputStat.size > MAX_FILE_BYTES;

  if (!needsResize && !needsReencode) {
    return { path: filePath, mime, cleanup: null, cacheStatus: 'none' };
  }

  const baseTemp = tempRoot || os.tmpdir();
  let tempDir: string | null = null;
  let outPath = '';

  if (cacheDir) {
    outPath = buildCachedMistralPath(filePath, '.jpg', cacheDir, baseInput, tempRoot);
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true }).catch(() => {});

    const cachedStat = await fs.promises.stat(outPath).catch(() => null);
    if (cachedStat && cachedStat.size > 0) {
      return { path: outPath, mime: 'image/jpeg', cleanup: null, cacheStatus: 'hit' };
    }
    // Remove stale 0-byte cache files from previous failed/cancelled runs
    if (cachedStat && cachedStat.size === 0) {
      await fs.promises.rm(outPath, { force: true }).catch(() => {});
    }
  } else {
    await fs.promises.mkdir(baseTemp, { recursive: true }).catch(() => {});
    tempDir = await fs.promises.mkdtemp(path.join(baseTemp, 'mistral-prep-'));
    outPath = path.join(tempDir, `${path.basename(filePath, ext)}.jpg`);
  }

  if (requiresCompatibleUpload) {
    try {
      if (sharp) {
        await writeOptimizedJpeg(filePath, outPath, needsResize);
      } else {
        await convertImageToJpegWithSips(filePath, outPath);
      }
    } catch (error) {
      try {
        await convertImageToJpegWithSips(filePath, outPath);
      } catch (fallbackError) {
        const detail = fallbackError instanceof Error && fallbackError.message
          ? fallbackError.message
          : (error instanceof Error && error.message ? error.message : 'Unknown error');
        throw new Error(`Failed to convert JP2 to JPEG before Mistral upload: ${detail}`);
      }
    }

    return {
      path: outPath,
      mime: 'image/jpeg',
      cleanup: tempDir
        ? async () => {
          await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
        : null,
      cacheStatus: cacheDir ? 'created' : 'none'
    };
  }

  try {
    if (sharp) {
      await writeOptimizedJpeg(filePath, outPath, needsResize);
    } else {
      await convertImageToJpegWithSips(filePath, outPath);
    }
  } catch (error) {
    try {
      await convertImageToJpegWithSips(filePath, outPath);
    } catch (fallbackError) {
      const detail = fallbackError instanceof Error && fallbackError.message
        ? fallbackError.message
        : (error instanceof Error && error.message ? error.message : 'Unknown error');
      throw new Error(`Failed to preprocess image for Mistral upload: ${detail}`);
    }
  }

  return {
    path: outPath,
    mime: 'image/jpeg',
    cleanup: tempDir
      ? async () => {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
      : null,
    cacheStatus: cacheDir ? 'created' : 'none'
  };
}

export async function prepareImageForMistral(
  filePath: string,
  cacheDir?: string,
  baseInput?: string,
  tempRoot?: string
): Promise<MistralPreprocessResult> {
  return await preprocessForMistral(filePath, cacheDir, baseInput, tempRoot);
}

async function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => resolve(), ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timeout);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true }
      );
    }
  });
}

async function uploadFileToMistral(
  filePath: string,
  apiKey: string,
  purpose: 'ocr' | 'batch',
  signal?: AbortSignal,
  logger?: (msg: string) => void | Promise<void>
): Promise<{ id: string; fileName: string }> {
  if (signal?.aborted) throw abortError();
  const data = await fs.promises.readFile(filePath);
  if (data.length === 0) {
    throw new Error(`Cannot upload empty file: ${path.basename(filePath)}`);
  }
  const mime = mimeFor(filePath);
  const maxRetries = 5;
  const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
  const retryableCodes = new Set([
    'EPIPE',
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT'
  ]);
  const describeUploadError = (error: any): string => {
    const cause = error?.cause;
    const directCode = typeof error?.code === 'string' ? error.code : '';
    const causeCode = typeof cause?.code === 'string' ? cause.code : '';
    const code = causeCode || directCode;
    const message = typeof error?.message === 'string' ? error.message : String(error);
    return code && !message.includes(code) ? `${message} (${code})` : message;
  };
  const shouldRetry = (error: any): boolean => {
    if (!error) return false;
    if (error instanceof DOMException && error.name === 'AbortError') return false;
    if (signal?.aborted) return false;
    if (retryableStatuses.has(Number(error?.status))) return true;
    const cause = error?.cause;
    const code = typeof cause?.code === 'string'
      ? cause.code
      : (typeof error?.code === 'string' ? error.code : '');
    if (retryableCodes.has(code)) return true;
    const message = String(error?.message || '').toLowerCase();
    return message.includes('fetch failed') || message.includes('socket') || message.includes('network');
  };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal?.aborted) throw abortError();
    try {
      const form = new FormData();
      form.append('file', new Blob([data], { type: mime }), path.basename(filePath));
      form.append('purpose', purpose);

      const resp = await fetch('https://api.mistral.ai/v1/files', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Connection: 'close'
        },
        body: form,
        signal
      });

      if (!resp.ok) {
        const errText = sanitizeMistralErrorText(await resp.text().catch(() => ''));
        const err: any = new Error(`Mistral file upload failed: ${resp.status} ${resp.statusText} ${errText}`);
        err.status = resp.status;
        throw err;
      }

      const json = await resp.json();
      const id = json?.id;
      if (!id) {
        throw new Error('Mistral file upload missing id in response');
      }
      return { id, fileName: path.basename(filePath) };
    } catch (error: any) {
      if ((error instanceof DOMException && error.name === 'AbortError') || signal?.aborted) {
        throw abortError();
      }
      if (attempt === maxRetries - 1 || !shouldRetry(error)) {
        if (typeof error?.status === 'number') {
          throw error;
        }
        const wrapped: any = new Error(
          `Mistral file upload failed for ${path.basename(filePath)}: ${describeUploadError(error)}`
        );
        wrapped.cause = error;
        throw wrapped;
      }
      const delayMs = 2000 * Math.pow(2, attempt);
      if (logger) {
        await logger(
          `Upload attempt ${attempt + 1}/${maxRetries} failed for ${path.basename(filePath)}: ${describeUploadError(error)}. Retrying in ${delayMs}ms...`
        );
      }
      await sleep(delayMs, signal);
    }
  }

  throw new Error(`Mistral file upload failed for ${path.basename(filePath)}`);
}

async function getSignedUrl(fileId: string, apiKey: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortError();
  
  const maxRetries = 6;
  const baseDelayMs = 2000;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal?.aborted) throw abortError();
    
    try {
      const resp = await fetch(`https://api.mistral.ai/v1/files/${fileId}/url`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Connection: 'close'
        },
        signal
      });
      
      if (resp.ok) {
        const json = await resp.json();
        const url = json?.url;
        if (!url) throw new Error('Mistral signed URL response missing url');
        return url;
      }
      
      if (resp.status === 404 && attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await sleep(delay, signal);
        continue;
      }
      
      const errText = sanitizeMistralErrorText(await resp.text().catch(() => ''));
      const err: any = new Error(`Mistral signed URL failed: ${resp.status} ${resp.statusText} ${errText}`);
      err.status = resp.status;
      throw err;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      
      if (attempt === maxRetries - 1) {
        throw error;
      }
      
      const delay = baseDelayMs * Math.pow(2, attempt);
      await sleep(delay, signal);
    }
  }
  
  throw new Error(`Failed to get signed URL after ${maxRetries} attempts`);
}

async function createBatchJob(
  batchFileId: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal
): Promise<any> {
  if (signal?.aborted) throw abortError();
  const resp = await fetch('https://api.mistral.ai/v1/batch/jobs', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input_files: [batchFileId],
      model,
      endpoint: '/v1/ocr',
      metadata: { job_type: 'ocr' }
    }),
    signal
  });

  if (!resp.ok) {
    const errText = sanitizeMistralErrorText(await resp.text().catch(() => ''));
    const err: any = new Error(`Mistral batch job creation failed: ${resp.status} ${resp.statusText} ${errText}`);
    err.status = resp.status;
    throw err;
  }
  return await resp.json();
}

async function fetchBatchJob(jobId: string, apiKey: string, signal?: AbortSignal): Promise<any> {
  if (signal?.aborted) throw abortError();
  const resp = await fetch(`https://api.mistral.ai/v1/batch/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal
  });
  if (!resp.ok) {
    const errText = sanitizeMistralErrorText(await resp.text().catch(() => ''));
    const err: any = new Error(`Mistral batch status failed: ${resp.status} ${resp.statusText} ${errText}`);
    err.status = resp.status;
    throw err;
  }
  return await resp.json();
}

async function downloadFileContent(fileId: string, apiKey: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortError();
  const resp = await fetch(`https://api.mistral.ai/v1/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal
  });
  if (!resp.ok) {
    const errText = sanitizeMistralErrorText(await resp.text().catch(() => ''));
    const err: any = new Error(`Mistral file download failed: ${resp.status} ${resp.statusText} ${errText}`);
    err.status = resp.status;
    throw err;
  }
  return await resp.text();
}

export async function transcribeImageMistralDetailed(
  filePath: string,
  apiKey: string,
  modelName: string = 'mistral-ocr-latest',
  options: {
    includeImageBase64?: boolean;
    includeImageDescriptions?: boolean;
    signal?: AbortSignal;
    logger?: (msg: string) => void | Promise<void>;
    cacheDir?: string;
    baseInput?: string;
    tempRoot?: string;
  } = {}
): Promise<MistralOcrResult> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) {
    throw new Error('Input must be a file for Mistral OCR');
  }
  if (!isMistralSupported(filePath)) {
    throw new Error('Unsupported file type for Mistral OCR');
  }

  const prep = await prepareImageForMistral(filePath, options.cacheDir, options.baseInput, options.tempRoot);

  currentController = new AbortController();
  const useSignal = currentController.signal;
  const externalSignal = options.signal;
  if (externalSignal) {
    if (externalSignal.aborted) {
      currentController.abort();
    } else {
      externalSignal.addEventListener('abort', () => currentController?.abort(), { once: true });
    }
  }
  const includeImageBase64 = Boolean(options.includeImageBase64);
  const includeImageDescriptions = Boolean(options.includeImageDescriptions);

  return await new Promise<MistralOcrResult>(async (resolve, reject) => {
    currentReject = reject;
    try {
      const result = await transcribePreparedImageMistralDetailed(prep.path, apiKey, modelName, {
        includeImageBase64,
        includeImageDescriptions,
        signal: useSignal,
        logger: options.logger
      });
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      if (prep.cleanup) {
        prep.cleanup().catch(() => {});
      }
      currentController = null;
      currentReject = null;
    }
  });
}

export async function transcribeImageMistral(
  filePath: string,
  apiKey: string,
  modelName: string = 'mistral-ocr-latest',
  options: {
    signal?: AbortSignal;
    logger?: (msg: string) => void | Promise<void>;
    cacheDir?: string;
    baseInput?: string;
    tempRoot?: string;
  } = {}
): Promise<string> {
  const detailed = await transcribeImageMistralDetailed(filePath, apiKey, modelName, {
    ...options,
    includeImageBase64: false
  });
  return detailed.text;
}

export async function transcribePreparedImageMistralDetailed(
  preparedPath: string,
  apiKey: string,
  modelName: string = 'mistral-ocr-latest',
  options: {
    includeImageBase64?: boolean;
    includeImageDescriptions?: boolean;
    signal?: AbortSignal;
    logger?: (msg: string) => void | Promise<void>;
  } = {}
): Promise<MistralOcrResult> {
  if (options.signal?.aborted) throw abortError();

  const includeImageBase64 = Boolean(options.includeImageBase64);
  const includeImageDescriptions = Boolean(options.includeImageDescriptions);
  const { id } = await uploadFileToMistral(preparedPath, apiKey, 'ocr', options.signal, options.logger);
  const signedUrl = await getSignedUrl(id, apiKey, options.signal);
  const body: Record<string, unknown> = {
    model: modelName,
    document: {
      type: 'document_url',
      document_url: signedUrl
    },
    include_image_base64: includeImageBase64
  };
  if (includeImageDescriptions) {
    body.bbox_annotation_format = ACCESSIBLE_IMAGE_ANNOTATION_FORMAT;
  }

  const resp = await fetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: options.signal
  });

  if (!resp.ok) {
    const errText = sanitizeMistralErrorText(await resp.text().catch(() => ''));
    const err: any = new Error(`Mistral OCR failed: ${resp.status} ${resp.statusText} ${errText}`);
    err.status = resp.status;
    throw err;
  }

  const json = await resp.json();
  return parseOcrPayload(json);
}

export interface MistralBatchSubmitOptions {
  baseInput?: string;
  logger?: (msg: string) => void | Promise<void>;
  signal?: AbortSignal;
  cacheDir?: string;
  tempRoot?: string;
  includeImageBase64?: boolean;
  includeImageDescriptions?: boolean;
  preprocessWorkers?: number;
  uploadWorkers?: number;
}

export interface SubmittedMistralBatchJob {
  jobId: string;
  status: string;
  totalRequests: number;
  succeededRequests: number;
  failedRequests: number;
  outputFileId: string | null;
}

const MIN_MISTRAL_BATCH_WORKERS = 1;
const MAX_MISTRAL_BATCH_WORKERS = 5;
const DEFAULT_MISTRAL_BATCH_PREPROCESS_WORKERS = 2;
const DEFAULT_MISTRAL_BATCH_UPLOAD_WORKERS = 2;

export interface MistralBatchTranscribeOptions extends MistralBatchSubmitOptions {
  pollIntervalMs?: number;
}

export interface MistralBatchJobStatus {
  id: string;
  status: string;
  totalRequests: number;
  succeededRequests: number;
  failedRequests: number;
  outputFileId: string | null;
  errorFileId: string | null;
  errorMessages: string[];
}

function normalizeBatchJobStatus(jobState: any, fallbackTotal: number): MistralBatchJobStatus {
  const total = Math.max(
    Number(jobState?.total_requests ?? fallbackTotal ?? 0),
    Number(jobState?.succeeded_requests ?? 0) + Number(jobState?.failed_requests ?? 0),
    0
  );
  const errorMessages = Array.isArray(jobState?.errors)
    ? jobState.errors
      .map((entry: any) => typeof entry?.message === 'string' ? entry.message.trim() : '')
      .filter(Boolean)
    : [];
  return {
    id: String(jobState?.id || ''),
    status: String(jobState?.status || 'UNKNOWN'),
    totalRequests: total,
    succeededRequests: Math.max(Number(jobState?.succeeded_requests ?? 0), 0),
    failedRequests: Math.max(Number(jobState?.failed_requests ?? 0), 0),
    outputFileId: typeof jobState?.output_file === 'string' && jobState.output_file
      ? jobState.output_file
      : null,
    errorFileId: typeof jobState?.error_file === 'string' && jobState.error_file
      ? jobState.error_file
      : null,
    errorMessages
  };
}

function isTerminalBatchStatus(status: string): boolean {
  return status === 'SUCCESS' || status === 'FAILED' || status === 'CANCELLED';
}

function parseMistralBatchResultTextDetailed(resultsText: string): Map<string, MistralOcrResult> {
  const results = new Map<string, MistralOcrResult>();
  for (const line of resultsText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: any;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const customId = typeof rec?.custom_id === 'string' ? rec.custom_id : undefined;
    if (!customId) continue;
    const body = rec?.response?.body ?? rec?.body ?? rec?.response ?? rec;
    results.set(customId, parseOcrPayload(body));
  }
  return results;
}

export interface MistralBatchRequestError {
  customId: string;
  statusCode: number | null;
  message: string;
}

function parseMistralBatchErrorText(resultsText: string): MistralBatchRequestError[] {
  const errors: MistralBatchRequestError[] = [];
  for (const line of resultsText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: any;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const statusCode = Number.isFinite(Number(rec?.response?.status_code))
      ? Number(rec.response.status_code)
      : null;
    let message = '';
    const responseBody = rec?.response?.body;
    if (typeof responseBody === 'string' && responseBody.trim()) {
      try {
        const parsed = JSON.parse(responseBody);
        message = typeof parsed?.message === 'string' ? parsed.message.trim() : responseBody.trim();
      } catch {
        message = responseBody.trim();
      }
    } else if (responseBody && typeof responseBody === 'object' && typeof responseBody?.message === 'string') {
      message = responseBody.message.trim();
    } else if (typeof rec?.error === 'string' && rec.error.trim()) {
      message = rec.error.trim();
    }

    if (!message && statusCode !== null) {
      message = `HTTP Error ${statusCode}`;
    }

    errors.push({
      customId: typeof rec?.custom_id === 'string' ? rec.custom_id : '',
      statusCode,
      message: sanitizeMistralErrorText(message || 'Unknown batch request error')
    });
  }
  return errors;
}

function bindSignal(external?: AbortSignal): AbortSignal {
  currentController = new AbortController();
  if (external) {
    if (external.aborted) {
      currentController.abort();
    } else {
      external.addEventListener('abort', () => currentController?.abort(), { once: true });
    }
  }
  return currentController.signal;
}

function manifestFilePath(baseDir: string): string {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  return path.join(baseDir, `ocr_batch_${stamp}.jsonl`);
}

function isPathInside(parentDir: string, candidatePath: string): boolean {
  const parent = path.resolve(parentDir);
  const child = path.resolve(candidatePath);
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function removeEmptyParentDirs(startDir: string, stopDir: string): Promise<void> {
  let current = path.resolve(startDir);
  const boundary = path.resolve(stopDir);
  while (current !== boundary && isPathInside(boundary, current)) {
    const entries = await fs.promises.readdir(current).catch(() => ['__keep__']);
    if (entries.length > 0) break;
    await fs.promises.rmdir(current).catch(() => {});
    current = path.dirname(current);
  }
}

function normalizeBatchWorkerCount(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_MISTRAL_BATCH_WORKERS, Math.max(MIN_MISTRAL_BATCH_WORKERS, Math.floor(parsed)));
}

function createConcurrencyLimiter(limit: number) {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const runNext = () => {
    if (activeCount >= normalizedLimit) return;
    const nextTask = queue.shift();
    if (!nextTask) return;
    activeCount += 1;
    nextTask();
  };

  return async function schedule<T>(task: () => Promise<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const execute = () => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            activeCount = Math.max(0, activeCount - 1);
            runNext();
          });
      };
      queue.push(execute);
      runNext();
    });
  };
}

type PreparedMistralBatchInput = {
  customId: string;
  filePath: string;
  uploadPath: string;
  cacheStatus: MistralPreprocessResult['cacheStatus'];
};

async function uploadPreparedMistralBatchInput(
  prep: PreparedMistralBatchInput,
  apiKey: string,
  signal: AbortSignal,
  log: (msg: string) => Promise<void>,
  initialDelayMs: number = 0
): Promise<{ customId: string; signedUrl: string; filePath: string }> {
  if (signal.aborted) throw abortError();
  if (initialDelayMs > 0) {
    await sleep(initialDelayMs, signal);
  }

  const maxUploadAttempts = 3;
  let signedUrl = '';
  for (let uploadAttempt = 0; uploadAttempt < maxUploadAttempts; uploadAttempt++) {
    if (signal.aborted) throw abortError();

    if (uploadAttempt > 0) {
      await log(`Re-uploading ${path.basename(prep.filePath)} (attempt ${uploadAttempt + 1}/${maxUploadAttempts})...`);
      await sleep(3000, signal);
    } else {
      await log(`Uploading ${path.basename(prep.filePath)}...`);
    }

    const { id } = await uploadFileToMistral(prep.uploadPath, apiKey, 'ocr', signal, log);
    await log(`Uploaded ${path.basename(prep.filePath)} as ${id}`);

    await sleep(1500, signal);

    try {
      signedUrl = await getSignedUrl(id, apiKey, signal);
      break;
    } catch (err: any) {
      if (err?.status === 404 && uploadAttempt < maxUploadAttempts - 1) {
        await log(`Signed URL not found for ${path.basename(prep.filePath)} (file ${id}), will re-upload...`);
        continue;
      }
      throw err;
    }
  }

  return {
    customId: prep.customId,
    signedUrl,
    filePath: prep.filePath
  };
}

export async function submitMistralBatchJob(
  files: string[],
  apiKey: string,
  modelName: string = 'mistral-ocr-latest',
  opts: MistralBatchSubmitOptions = {}
): Promise<SubmittedMistralBatchJob> {
  if (!files.length) {
    throw new Error('No files provided for Mistral batch OCR');
  }

  const baseInput = opts.baseInput ? path.resolve(opts.baseInput) : path.dirname(path.resolve(files[0]));
  const logFn = opts.logger ?? (() => {});
  const log = async (msg: string) => { try { await logFn(`[mistral-batch] ${msg}`); } catch {} };

  const useSignal = bindSignal(opts.signal);
  const cleanups: Array<() => Promise<void>> = [];
  let batchPath: string | null = null;
  let uploadSucceeded = false;
  const cachedTempFiles = new Set<string>();
  const cacheRoot = opts.cacheDir ? path.resolve(opts.cacheDir) : null;
  const preprocessWorkers = normalizeBatchWorkerCount(
    opts.preprocessWorkers,
    DEFAULT_MISTRAL_BATCH_PREPROCESS_WORKERS
  );
  const uploadWorkers = normalizeBatchWorkerCount(
    opts.uploadWorkers,
    DEFAULT_MISTRAL_BATCH_UPLOAD_WORKERS
  );

  try {
    const baseTemp = opts.tempRoot || os.tmpdir();
    await fs.promises.mkdir(baseTemp, { recursive: true }).catch(() => {});

    const manifestDir = opts.cacheDir || baseTemp;
    await fs.promises.mkdir(manifestDir, { recursive: true }).catch(() => {});
    batchPath = manifestFilePath(manifestDir);

    const preprocessLimit = createConcurrencyLimiter(preprocessWorkers);
    const uploadLimit = createConcurrencyLimiter(uploadWorkers);
    const uploadTasks: Array<Promise<{ customId: string; signedUrl: string; filePath: string }> | undefined> = new Array(files.length);

    await log(
      `Preprocessing ${files.length} file(s) before upload with ${preprocessWorkers} preprocess worker(s) and ${uploadWorkers} upload worker(s)...`
    );
    const preprocessTasks = files.map((file, index) =>
      preprocessLimit(async () => {
        await log(`Preprocessing ${path.basename(file)}...`);
        if (useSignal.aborted) throw abortError();

        const stat = await fs.promises.stat(file);
        if (!stat.isFile()) throw new Error(`Input must be a file: ${file}`);
        if (!isMistralSupported(file)) throw new Error(`Unsupported file type for Mistral OCR: ${file}`);

        const customId = normalizeCustomId(file, baseInput);
        const prep = await preprocessForMistral(file, opts.cacheDir, baseInput, baseTemp);
        if (prep.cacheStatus === 'hit') {
          await log(`Reusing cached image for ${path.basename(file)} at ${prep.path}`);
        } else if (prep.cacheStatus === 'created') {
          await log(`Cached preprocessed image for ${path.basename(file)} at ${prep.path}`);
        }
        if (prep.cleanup) cleanups.push(prep.cleanup);
        if (cacheRoot && isPathInside(cacheRoot, prep.path)) {
          cachedTempFiles.add(path.resolve(prep.path));
        }

        const prepared: PreparedMistralBatchInput = {
          customId,
          uploadPath: prep.path,
          filePath: path.resolve(file),
          cacheStatus: prep.cacheStatus
        };
        const staggerDelayMs = uploadWorkers > 1 ? (index % uploadWorkers) * 250 : 0;
        const uploadTask = uploadLimit(() =>
          uploadPreparedMistralBatchInput(prepared, apiKey, useSignal, log, staggerDelayMs)
        );
        uploadTask.catch(() => {});
        uploadTasks[index] = uploadTask;
      })
    );

    let uploads: { customId: string; signedUrl: string; filePath: string }[] = [];
    try {
      await Promise.all(preprocessTasks);
      await log(`Finished preprocessing ${files.length} file(s); waiting for upload queue to drain...`);
      const readyUploadTasks = uploadTasks.map((task, index) => {
        if (!task) {
          throw new Error(`Upload task was not scheduled for ${path.basename(files[index])}`);
        }
        return task;
      });
      uploads = await Promise.all(readyUploadTasks);
    } catch (error) {
      currentController?.abort();
      await Promise.allSettled(preprocessTasks);
      await Promise.allSettled(
        uploadTasks.filter(
          (task): task is Promise<{ customId: string; signedUrl: string; filePath: string }> => Boolean(task)
        )
      );
      throw error;
    }

    await log(`Uploads complete. Creating batch manifest...`);
    const includeImageBase64 = Boolean(opts.includeImageBase64);
    const includeImageDescriptions = Boolean(opts.includeImageDescriptions);
    const lines = uploads.map(u =>
      JSON.stringify({
        custom_id: u.customId,
        body: {
          document: { type: 'document_url', document_url: u.signedUrl },
          include_image_base64: includeImageBase64,
          ...(includeImageDescriptions ? { bbox_annotation_format: ACCESSIBLE_IMAGE_ANNOTATION_FORMAT } : {})
        }
      })
    );
    await fs.promises.writeFile(batchPath, lines.join('\n'), 'utf-8');
    await log(`Batch JSONL written (${uploads.length} lines) at ${batchPath}`);

    const { id: batchFileId } = await uploadFileToMistral(batchPath, apiKey, 'batch', useSignal, log);
    await log(`Uploaded batch manifest ${batchFileId}`);
    const job = await createBatchJob(batchFileId, apiKey, modelName, useSignal);
    const createdStatus = normalizeBatchJobStatus(job, uploads.length);
    const jobId = String(createdStatus.id || '');
    if (!jobId) {
      throw new Error('Mistral batch job creation returned no job id');
    }
    let initialStatus = createdStatus;
    if (!isTerminalBatchStatus(createdStatus.status)) {
      try {
        initialStatus = await fetchMistralBatchJobStatus(jobId, apiKey, useSignal);
      } catch (error: any) {
        await log(
          `Immediate status refresh failed for batch job ${jobId}; keeping creation response status ${createdStatus.status}: ${error?.message || error}`
        );
      }
    }
    await log(`Created batch job ${jobId} with status ${initialStatus.status}`);
    uploadSucceeded = true;
    return {
      jobId,
      status: initialStatus.status,
      totalRequests: Math.max(initialStatus.totalRequests, uploads.length),
      succeededRequests: initialStatus.succeededRequests,
      failedRequests: initialStatus.failedRequests,
      outputFileId: initialStatus.outputFileId
    };
  } finally {
    currentController = null;
    currentReject = null;
    for (const clean of cleanups) {
      clean().catch(() => {});
    }
    if (batchPath) {
      fs.promises.rm(batchPath, { force: true }).catch(() => {});
    }
    if (uploadSucceeded && cacheRoot) {
      for (const filePath of cachedTempFiles) {
        await fs.promises.rm(filePath, { force: true }).catch(() => {});
        await removeEmptyParentDirs(path.dirname(filePath), cacheRoot).catch(() => {});
      }
    }
  }
}

export async function fetchMistralBatchJobStatus(
  jobId: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<MistralBatchJobStatus> {
  const useSignal = bindSignal(signal);
  try {
    const jobState = await fetchBatchJob(jobId, apiKey, useSignal);
    return normalizeBatchJobStatus(jobState, 0);
  } finally {
    currentController = null;
    currentReject = null;
  }
}

export async function downloadMistralBatchResultsDetailed(
  outputFileId: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<Map<string, MistralOcrResult>> {
  if (!outputFileId) {
    throw new Error('Missing output file id for Mistral batch results');
  }
  const useSignal = bindSignal(signal);
  try {
    const resultsText = await downloadFileContent(outputFileId, apiKey, useSignal);
    return parseMistralBatchResultTextDetailed(resultsText);
  } finally {
    currentController = null;
    currentReject = null;
  }
}

export async function downloadMistralBatchErrors(
  errorFileId: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<MistralBatchRequestError[]> {
  if (!errorFileId) {
    throw new Error('Missing error file id for Mistral batch errors');
  }
  const useSignal = bindSignal(signal);
  try {
    const errorText = await downloadFileContent(errorFileId, apiKey, useSignal);
    return parseMistralBatchErrorText(errorText);
  } finally {
    currentController = null;
    currentReject = null;
  }
}

export async function downloadMistralBatchResults(
  outputFileId: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const detailed = await downloadMistralBatchResultsDetailed(outputFileId, apiKey, signal);
  const flattened = new Map<string, string>();
  for (const [key, value] of detailed.entries()) {
    flattened.set(key, value.text);
  }
  return flattened;
}

export async function transcribeImageMistralBatch(
  files: string[],
  apiKey: string,
  modelName: string = 'mistral-ocr-latest',
  opts: MistralBatchTranscribeOptions = {}
): Promise<Map<string, string>> {
  if (!files.length) {
    throw new Error('No files provided for Mistral batch OCR');
  }

  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const logFn = opts.logger ?? (() => {});
  const log = async (msg: string) => { try { await logFn(`[mistral-batch] ${msg}`); } catch {} };

  const useSignal = bindSignal(opts.signal);

  return await new Promise<Map<string, string>>(async (resolve, reject) => {
    currentReject = reject;
    try {
      const submission = await submitMistralBatchJob(files, apiKey, modelName, {
        baseInput: opts.baseInput,
        logger: opts.logger,
        signal: useSignal,
        cacheDir: opts.cacheDir,
        tempRoot: opts.tempRoot,
        includeImageBase64: opts.includeImageBase64
      });

      let status = await fetchMistralBatchJobStatus(submission.jobId, apiKey, useSignal);
      while (!isTerminalBatchStatus(status.status)) {
        await sleep(pollIntervalMs, useSignal);
        status = await fetchMistralBatchJobStatus(submission.jobId, apiKey, useSignal);
        const done = status.succeededRequests + status.failedRequests;
        const total = Math.max(status.totalRequests || submission.totalRequests, 1);
        await log(`Job ${submission.jobId} status=${status.status} ${done}/${total}`);
      }

      if (status.status !== 'SUCCESS') {
        throw new Error(`Batch ended with status ${status.status}`);
      }
      if (!status.outputFileId) {
        const detail = status.errorMessages.length
          ? ` ${status.errorMessages.join('; ')}`
          : '';
        throw new Error(`Batch ${submission.jobId} completed without an output file.${detail}`);
      }

      await log(`Job ${submission.jobId} succeeded, downloading results ${status.outputFileId}`);
      const results = await downloadMistralBatchResults(status.outputFileId, apiKey, useSignal);
      resolve(results);
    } catch (err) {
      reject(err);
    } finally {
      currentController = null;
      currentReject = null;
    }
  });
}
