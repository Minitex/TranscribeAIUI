import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { callMarkdownWorker } from './markdownRenderWorker.js';

let currentController: AbortController | null = null;
let currentReject: ((err: any) => void) | null = null;

const SUPPORTED_EXTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.jp2', '.tif', '.tiff', '.bmp', '.gif', '.webp']);
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
    case '.webp': return 'image/webp';
    case '.pdf': return 'application/pdf';
    case '.mp3': return 'audio/mpeg';
    case '.mp4': return 'audio/mp4';
    case '.wav': return 'audio/wav';
    case '.m4a': return 'audio/mp4';
    case '.aac': return 'audio/aac';
    case '.flac': return 'audio/flac';
    case '.ogg': return 'audio/ogg';
    case '.avi': return 'video/x-msvideo';
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

export interface MistralOcrWordConfidence {
  text: string;
  confidence: number;
}

export interface MistralOcrConfidence {
  averagePageConfidenceScore?: number;
  minimumPageConfidenceScore?: number;
  words?: MistralOcrWordConfidence[];
}

export interface MistralOcrBlockBoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface MistralOcrBlock {
  type: string;
  bbox: MistralOcrBlockBoundingBox;
  text: string;
}

export interface MistralOcrPageResult {
  index: number;
  markdown: string;
  markdownWithImages: string;
  dimensions: MistralOcrPageDimensions;
  confidence?: MistralOcrConfidence;
  blocks?: MistralOcrBlock[];
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

// embedImagesIntoMarkdown (and its image-annotation/data-URI helpers) used
// to live here as synchronous, regex-heavy code over potentially large OCR
// markdown. It now lives in markdownRenderWorker.ts and runs on a shared
// worker thread via callMarkdownWorker(), so it never blocks Electron's
// main-process event loop regardless of input size.
async function embedImagesIntoMarkdown(markdown: string, pageImages: any[]): Promise<string> {
  return callMarkdownWorker<string>('embedImagesIntoMarkdown', [markdown, pageImages]);
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

// cleanMarkdown used to live here as a synchronous, regex-heavy replace
// chain over potentially large OCR markdown. It now lives in
// markdownRenderWorker.ts and runs on a shared worker thread via
// callMarkdownWorker(), so it never blocks Electron's main-process event
// loop regardless of input size.
export async function cleanMarkdown(text: string): Promise<string> {
  return callMarkdownWorker<string>('cleanMarkdown', [text]);
}

// Field names below match Mistral's documented OCR 4 schema (confidence_scores.*,
// blocks[].top_left_x etc). Docs disagreed with themselves on a couple of details, so every
// read here is optional-chained — an unrecognized shape just yields undefined, never a crash.
function parseConfidence(page: any): MistralOcrConfidence | undefined {
  const scores = page?.confidence_scores;
  if (!scores || typeof scores !== 'object') return undefined;
  const words = Array.isArray(scores.word_confidence_scores)
    ? scores.word_confidence_scores
      .map((w: any): MistralOcrWordConfidence | undefined => {
        const text = typeof w?.text === 'string' ? w.text : undefined;
        const confidence = normalizeNumber(w?.confidence);
        return text !== undefined && confidence !== undefined ? { text, confidence } : undefined;
      })
      .filter((w: MistralOcrWordConfidence | undefined): w is MistralOcrWordConfidence => Boolean(w))
    : undefined;
  const averagePageConfidenceScore = normalizeNumber(scores.average_page_confidence_score);
  const minimumPageConfidenceScore = normalizeNumber(scores.minimum_page_confidence_score);
  if (!words?.length && averagePageConfidenceScore === undefined && minimumPageConfidenceScore === undefined) {
    return undefined;
  }
  return { averagePageConfidenceScore, minimumPageConfidenceScore, words };
}

function parseBlocks(page: any): MistralOcrBlock[] | undefined {
  const rawBlocks = Array.isArray(page?.blocks) ? page.blocks : undefined;
  if (!rawBlocks?.length) return undefined;
  const blocks = rawBlocks
    .map((b: any): MistralOcrBlock | undefined => {
      const x0 = normalizeNumber(b?.top_left_x);
      const y0 = normalizeNumber(b?.top_left_y);
      const x1 = normalizeNumber(b?.bottom_right_x);
      const y1 = normalizeNumber(b?.bottom_right_y);
      if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) return undefined;
      const text = typeof b?.content === 'string' ? b.content : (typeof b?.text === 'string' ? b.text : '');
      const type = typeof b?.type === 'string' ? b.type : 'text';
      return { type, bbox: { x0, y0, x1, y1 }, text };
    })
    .filter((b: MistralOcrBlock | undefined): b is MistralOcrBlock => Boolean(b));
  return blocks.length ? blocks : undefined;
}

async function parseOcrPayload(payload: any): Promise<MistralOcrResult> {
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
      const markdownWithImages = await embedImagesIntoMarkdown(markdown, images);
      const text = await cleanMarkdown(markdown);
      if (text) parts.push(text);
      pages.push({
        index: i + 1,
        markdown,
        markdownWithImages,
        dimensions: {
          dpi: normalizeNumber(page?.dimensions?.dpi),
          width: normalizeNumber(page?.dimensions?.width),
          height: normalizeNumber(page?.dimensions?.height)
        },
        confidence: parseConfidence(page),
        blocks: parseBlocks(page)
      });
    }
    return { text: parts.join('\n\n').trim(), pages };
  }

  // Fallback for unexpected payload shapes.
  const sections = extractMarkdownSections(payload);
  for (let i = 0; i < sections.length; i++) {
    const markdown = typeof sections[i] === 'string' ? sections[i].trim() : '';
    if (!markdown) continue;
    const text = await cleanMarkdown(markdown);
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

// Mistral's vision/OCR image inputs cap at 20MB per image (docs.mistral.ai/resources/known-limitations);
// there's no documented pixel-dimension limit, so we only downsize as a last resort to fit that cap.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const JPEG_QUALITY_STEPS = [90, 82, 74, 66];
const RESIZE_FALLBACK_DIMENSION = 4096;

// Mistral's OCR docs cap a single /v1/ocr call at 1000 pages. This
// only guards the page-count ceiling, not the separate ~50MB size ceiling —
// a PDF under 1000 pages but over that size still fails whole. Upgrade path
// if that's hit in practice: physically split the PDF with pdf-lib (already
// a dependency here) instead of just paging the same upload.
const MISTRAL_OCR_MAX_PAGES_PER_CALL = 1000;

async function getPdfPageCount(filePath: string): Promise<number | null> {
  try {
    const bytes = await fs.promises.readFile(filePath);
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    return null;
  }
}

function mergeMistralOcrResults(results: MistralOcrResult[]): MistralOcrResult {
  const pages: MistralOcrPageResult[] = [];
  const textParts: string[] = [];
  for (const result of results) {
    for (const page of result.pages) {
      pages.push({ ...page, index: pages.length + 1 });
    }
    if (result.text) textParts.push(result.text);
  }
  return { text: textParts.join('\n\n').trim(), pages };
}

async function convertImageToJpegWithSips(inputPath: string, outputPath: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('sharp preprocessing failed and sips is only available on macOS');
  }

  await new Promise<void>((resolve, reject) => {
    execFile(
      '/usr/bin/sips',
      [
        '-s', 'format', 'jpeg',
        '--resampleHeightWidthMax', String(RESIZE_FALLBACK_DIMENSION),
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

async function writeOptimizedJpeg(inputPath: string, outputPath: string): Promise<void> {
  const sharpMod = await import('sharp');
  const sharp = sharpMod?.default ?? sharpMod;

  // Returns true once the file fits Mistral's 20MB image cap (or we've exhausted this pass's options).
  const tryQualitySteps = async (resize: boolean): Promise<boolean> => {
    for (let idx = 0; idx < JPEG_QUALITY_STEPS.length; idx++) {
      let pipeline = sharp(inputPath, { failOnError: false, limitInputPixels: false });
      if (resize) {
        pipeline = pipeline.resize({
          width: RESIZE_FALLBACK_DIMENSION,
          height: RESIZE_FALLBACK_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true
        });
      }
      await pipeline.jpeg({ quality: JPEG_QUALITY_STEPS[idx], mozjpeg: true }).toFile(outputPath);

      const written = await fs.promises.stat(outputPath).catch(() => null);
      if (!written || written.size <= MAX_FILE_BYTES) return true;
      if (idx === JPEG_QUALITY_STEPS.length - 1) return false;
    }
    return false;
  };

  // Quality reduction alone keeps full resolution; only downsize if that's not enough to fit the cap.
  if (!(await tryQualitySteps(false))) {
    await tryQualitySteps(true);
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
  // TIFF is an accepted OCR upload format, so it only gets forced
  // through the lossy JPEG path when oversized, same as PNG/JPG/BMP/GIF.
  // Multi-page or unusual-compression TIFFs could still fail upload as-is;
  // if that shows up in practice, add a re-encode-and-retry fallback on
  // failure rather than reinstating the unconditional transcode.
  const needsReencode = requiresCompatibleUpload || inputStat.size > MAX_FILE_BYTES;

  if (!needsReencode) {
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
        await writeOptimizedJpeg(filePath, outPath);
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
      await writeOptimizedJpeg(filePath, outPath);
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
  purpose: 'ocr' | 'batch' | 'audio',
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
  signal?: AbortSignal,
  endpoint: string = '/v1/ocr',
  jobType: string = 'ocr'
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
      endpoint,
      metadata: { job_type: jobType }
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

async function callMistralOcr(
  body: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal
): Promise<MistralOcrResult> {
  const resp = await fetch('https://api.mistral.ai/v1/ocr', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });

  if (!resp.ok) {
    const errText = sanitizeMistralErrorText(await resp.text().catch(() => ''));
    const err: any = new Error(`Mistral OCR failed: ${resp.status} ${resp.statusText} ${errText}`);
    err.status = resp.status;
    throw err;
  }

  const json = await resp.json();
  return await parseOcrPayload(json);
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
    include_image_base64: includeImageBase64,
    confidence_scores_granularity: 'word',
    include_blocks: true
  };
  if (includeImageDescriptions) {
    body.bbox_annotation_format = ACCESSIBLE_IMAGE_ANNOTATION_FORMAT;
  }

  const pageCount = path.extname(preparedPath).toLowerCase() === '.pdf'
    ? await getPdfPageCount(preparedPath)
    : null;

  if (pageCount !== null && pageCount > MISTRAL_OCR_MAX_PAGES_PER_CALL) {
    const callCount = Math.ceil(pageCount / MISTRAL_OCR_MAX_PAGES_PER_CALL);
    await options.logger?.(
      `PDF has ${pageCount} pages, over Mistral's ${MISTRAL_OCR_MAX_PAGES_PER_CALL}-page single-call limit; splitting into ${callCount} OCR call(s).`
    );
    const results: MistralOcrResult[] = [];
    for (let call = 0; call < callCount; call++) {
      if (options.signal?.aborted) throw abortError();
      const start = call * MISTRAL_OCR_MAX_PAGES_PER_CALL;
      const end = Math.min(pageCount, start + MISTRAL_OCR_MAX_PAGES_PER_CALL);
      await options.logger?.(`Requesting OCR for pages ${start + 1}-${end}...`);
      const pages = Array.from({ length: end - start }, (_, i) => start + i);
      results.push(await callMistralOcr({ ...body, pages }, apiKey, options.signal));
    }
    return mergeMistralOcrResults(results);
  }

  return callMistralOcr(body, apiKey, options.signal);
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

// A batch of a few hundred image pages, each with an embedded base64 scan in
// its response body, can be tens of MB of JSONL — parsing it all in one
// uninterrupted synchronous loop would stall the whole app for that
// duration. Yielding every PARSE_YIELD_LINES lines lets the event loop
// breathe between chunks without changing the parsed result.
const PARSE_YIELD_LINES = 200;

async function parseMistralBatchResultTextDetailed(resultsText: string): Promise<Map<string, MistralOcrResult>> {
  const results = new Map<string, MistralOcrResult>();
  const lines = resultsText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed) {
      let rec: any;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        rec = undefined;
      }
      const customId = typeof rec?.custom_id === 'string' ? rec.custom_id : undefined;
      if (customId) {
        const body = rec?.response?.body ?? rec?.body ?? rec?.response ?? rec;
        results.set(customId, await parseOcrPayload(body));
      }
    }
    if (i % PARSE_YIELD_LINES === PARSE_YIELD_LINES - 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
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
    // Unlike the sync path (transcribePreparedImageMistralDetailed),
    // batch lines don't get split for PDFs over Mistral's 1000-page-per-call
    // limit — one line is one document_url. An oversized PDF just fails that
    // line. Upgrade path if that's hit in practice: submit multiple lines per
    // such file (one per `pages` range) and merge them back by custom_id on
    // download.
    const lines = uploads.map(u =>
      JSON.stringify({
        custom_id: u.customId,
        body: {
          document: { type: 'document_url', document_url: u.signedUrl },
          include_image_base64: includeImageBase64,
          confidence_scores_granularity: 'word',
          include_blocks: true,
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

export interface MistralAudioBatchSubmitOptions {
  baseInput?: string;
  logger?: (msg: string) => void | Promise<void>;
  signal?: AbortSignal;
  cacheDir?: string;
  tempRoot?: string;
  uploadWorkers?: number;
  interviewMode?: boolean;
  subtitles?: boolean;
  contextBias?: string[];
  language?: string;
}

// Mistral's documented single-request ceiling for audio transcription
// (docs.mistral.ai/resources/known-limitations) is ~500MB / 60 minutes. The
// batch endpoint can't chunk a file, so an oversized one just fails its
// JSONL line; this only checks size (already stat'd per file below) since
// checking duration would need ffmpeg probing from audioTranscribe.ts, and
// importing that here risks a circular dependency for a warn-only check.
const MISTRAL_AUDIO_BATCH_MAX_BYTES = 500 * 1024 * 1024;

// Mirrors submitMistralBatchJob's shape (manifest -> upload manifest -> create
// job) but for Voxtral audio: no image preprocessing/caching step, files
// upload as-is. Long recordings that the sync path would split
// into ffmpeg chunks are uploaded whole here instead — chunking+merging N
// files x M chunks each inside one JSONL batch is a lot of bookkeeping for
// a case batch mode isn't the primary fit for (many short files, not few
// long ones). An oversized file just fails that one line; upgrade path is
// per-file chunk-then-submit if users hit this in practice.
export async function submitMistralAudioBatchJob(
  files: string[],
  apiKey: string,
  modelName: string = 'voxtral-mini-latest',
  opts: MistralAudioBatchSubmitOptions = {}
): Promise<SubmittedMistralBatchJob> {
  if (!files.length) {
    throw new Error('No files provided for Mistral batch audio transcription');
  }

  const baseInput = opts.baseInput ? path.resolve(opts.baseInput) : path.dirname(path.resolve(files[0]));
  const logFn = opts.logger ?? (() => {});
  const log = async (msg: string) => { try { await logFn(`[mistral-audio-batch] ${msg}`); } catch {} };

  const useSignal = bindSignal(opts.signal);
  let batchPath: string | null = null;
  const uploadWorkers = normalizeBatchWorkerCount(opts.uploadWorkers, DEFAULT_MISTRAL_BATCH_UPLOAD_WORKERS);

  try {
    const baseTemp = opts.tempRoot || os.tmpdir();
    await fs.promises.mkdir(baseTemp, { recursive: true }).catch(() => {});
    const manifestDir = opts.cacheDir || baseTemp;
    await fs.promises.mkdir(manifestDir, { recursive: true }).catch(() => {});
    batchPath = manifestFilePath(manifestDir);

    const uploadLimit = createConcurrencyLimiter(uploadWorkers);
    await log(`Uploading ${files.length} audio file(s) with ${uploadWorkers} upload worker(s)...`);

    const uploads = await Promise.all(files.map((file, index) =>
      uploadLimit(async () => {
        if (useSignal.aborted) throw abortError();
        const stat = await fs.promises.stat(file);
        if (!stat.isFile()) throw new Error(`Input must be a file: ${file}`);
        if (stat.size > MISTRAL_AUDIO_BATCH_MAX_BYTES) {
          await log(
            `[WARN] ${path.basename(file)} is ${(stat.size / (1024 * 1024)).toFixed(0)}MB, over Mistral's ~500MB single-request limit; this file may fail.`
          );
        }
        const customId = normalizeCustomId(file, baseInput);
        const staggerDelayMs = uploadWorkers > 1 ? (index % uploadWorkers) * 250 : 0;
        if (staggerDelayMs) await sleep(staggerDelayMs, useSignal);
        await log(`Uploading ${path.basename(file)}...`);
        const { id } = await uploadFileToMistral(file, apiKey, 'audio', useSignal, log);
        const signedUrl = await getSignedUrl(id, apiKey, useSignal);
        return { customId, signedUrl };
      })
    ));

    await log('Uploads complete. Creating batch manifest...');
    // language is documented as mutually exclusive with timestamp_granularities.
    const canSendLanguage = Boolean(opts.language) && !opts.subtitles && !opts.interviewMode;
    const lines = uploads.map(u => JSON.stringify({
      custom_id: u.customId,
      body: {
        model: modelName,
        file_url: u.signedUrl,
        ...(opts.subtitles || opts.interviewMode ? { timestamp_granularities: ['segment'] } : {}),
        ...(opts.interviewMode ? { diarize: true } : {}),
        ...(opts.contextBias?.length ? { context_bias: opts.contextBias } : {}),
        ...(canSendLanguage ? { language: opts.language } : {})
      }
    }));
    await fs.promises.writeFile(batchPath, lines.join('\n'), 'utf-8');
    await log(`Batch JSONL written (${uploads.length} lines) at ${batchPath}`);

    const { id: batchFileId } = await uploadFileToMistral(batchPath, apiKey, 'batch', useSignal, log);
    await log(`Uploaded batch manifest ${batchFileId}`);
    const job = await createBatchJob(batchFileId, apiKey, modelName, useSignal, '/v1/audio/transcriptions', 'audio_transcription');
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
    if (batchPath) {
      fs.promises.rm(batchPath, { force: true }).catch(() => {});
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
    return await parseMistralBatchResultTextDetailed(resultsText);
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

// Endpoint-agnostic batch result reader: returns each line's raw response
// body keyed by custom_id, with no assumption about what endpoint produced
// it (OCR, audio transcription, etc.) — callers apply their own payload
// interpretation (parseOcrPayload, extractMistralSegments, ...).
export async function downloadMistralBatchResultBodies(
  outputFileId: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<Map<string, any>> {
  if (!outputFileId) {
    throw new Error('Missing output file id for Mistral batch results');
  }
  const useSignal = bindSignal(signal);
  try {
    const resultsText = await downloadFileContent(outputFileId, apiKey, useSignal);
    const results = new Map<string, any>();
    const lines = resultsText.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed) {
        let rec: any;
        try {
          rec = JSON.parse(trimmed);
        } catch {
          rec = undefined;
        }
        const customId = typeof rec?.custom_id === 'string' ? rec.custom_id : undefined;
        if (customId) {
          results.set(customId, rec?.response?.body ?? rec?.body ?? rec?.response ?? rec);
        }
      }
      if (i % PARSE_YIELD_LINES === PARSE_YIELD_LINES - 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    return results;
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
