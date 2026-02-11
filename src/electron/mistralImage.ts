import fs from 'fs';
import os from 'os';
import path from 'path';

let currentController: AbortController | null = null;
let currentReject: ((err: any) => void) | null = null;

const SUPPORTED_EXTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.gif']);
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

const MAX_DIMENSION = 4096;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB threshold to re-encode

async function preprocessForMistral(
  filePath: string,
  cacheDir?: string,
  baseInput?: string,
  tempRoot?: string
): Promise<{ path: string; mime: string; cleanup: (() => Promise<void>) | null }> {
  const ext = path.extname(filePath).toLowerCase();
  // PDFs pass through untouched
  if (ext === '.pdf') {
    return { path: filePath, mime: mimeFor(filePath), cleanup: null };
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
      const meta = await sharp(filePath, { failOnError: false }).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      needsResize = width > MAX_DIMENSION || height > MAX_DIMENSION;
    } catch {
      needsResize = false;
    }
  }
  const needsReencode = ext === '.tif' || ext === '.tiff' || inputStat.size > MAX_FILE_BYTES;

  // Determine destination directory
  const baseTemp = tempRoot || os.tmpdir();
  let outDir = cacheDir || baseTemp;
  if (cacheDir && baseInput) {
    const rel = path.relative(path.resolve(baseInput), path.resolve(filePath));
    outDir = path.join(cacheDir, path.dirname(rel));
  }
  await fs.promises.mkdir(outDir, { recursive: true }).catch(() => {});
  const outPath = path.join(outDir, `${path.basename(filePath, ext)}.png`);

  // Reuse if already cached
  const exists = await fs.promises.stat(outPath).then(() => true).catch(() => false);
  if (exists) {
    return { path: outPath, mime: 'image/png', cleanup: null };
  }

  try {
    if (sharp && (needsResize || needsReencode || cacheDir)) {
      const img = sharp(filePath, { failOnError: false });
      const transformer = needsResize
        ? img.resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true }).png()
        : img.png();
      await transformer.toFile(outPath);
    } else {
      await fs.promises.copyFile(filePath, outPath);
    }
  } catch {
    await fs.promises.copyFile(filePath, outPath).catch(() => {});
  }

  return { path: outPath, mime: 'image/png', cleanup: null };
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
  signal?: AbortSignal
): Promise<{ id: string; fileName: string }> {
  if (signal?.aborted) throw abortError();
  const data = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([data]), path.basename(filePath));
  form.append('purpose', purpose);

  const resp = await fetch('https://api.mistral.ai/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
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
}

async function getSignedUrl(fileId: string, apiKey: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortError();
  
  const maxRetries = 3;
  const baseDelayMs = 1000;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal?.aborted) throw abortError();
    
    try {
      const resp = await fetch(`https://api.mistral.ai/v1/files/${fileId}/url`, {
        headers: { Authorization: `Bearer ${apiKey}` },
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

export async function transcribeImageMistral(
  filePath: string,
  apiKey: string,
  modelName: string = 'mistral-ocr-latest'
): Promise<string> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) {
    throw new Error('Input must be a file for Mistral OCR');
  }
  if (!isMistralSupported(filePath)) {
    throw new Error('Unsupported file type for Mistral OCR');
  }

  const prep = await preprocessForMistral(filePath);

  currentController = new AbortController();

  return await new Promise<string>(async (resolve, reject) => {
    currentReject = reject;
    try {
      const { id } = await uploadFileToMistral(prep.path, apiKey, 'ocr', currentController?.signal);
      const signedUrl = await getSignedUrl(id, apiKey, currentController?.signal);
      const body = {
        model: modelName,
        document: {
          type: 'document_url',
          document_url: signedUrl
        },
        include_image_base64: false
      };

      const resp = await fetch('https://api.mistral.ai/v1/ocr', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: currentController?.signal
      });

      if (!resp.ok) {
        const errText = sanitizeMistralErrorText(await resp.text().catch(() => ''));
        const err: any = new Error(`Mistral OCR failed: ${resp.status} ${resp.statusText} ${errText}`);
        err.status = resp.status;
        throw err;
      }

      const json = await resp.json();
      const pages = Array.isArray(json?.pages) ? json.pages : [];
      const parts: string[] = [];
      for (const p of pages) {
        const md = (p && typeof p.markdown === 'string') ? p.markdown : '';
        if (md) parts.push(md.trim());
      }
      const raw = parts.join('\n\n');
      try {
        resolve(cleanMarkdown(raw));
      } catch (err: any) {
        if (err instanceof RangeError) {
          resolve(raw.trim());
          return;
        }
        throw err;
      }
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

export interface MistralBatchSubmitOptions {
  baseInput?: string;
  logger?: (msg: string) => void | Promise<void>;
  signal?: AbortSignal;
  cacheDir?: string;
  tempRoot?: string;
}

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
}

function normalizeBatchJobStatus(jobState: any, fallbackTotal: number): MistralBatchJobStatus {
  const total = Math.max(
    Number(jobState?.total_requests ?? fallbackTotal ?? 0),
    Number(jobState?.succeeded_requests ?? 0) + Number(jobState?.failed_requests ?? 0),
    0
  );
  return {
    id: String(jobState?.id || ''),
    status: String(jobState?.status || 'UNKNOWN'),
    totalRequests: total,
    succeededRequests: Math.max(Number(jobState?.succeeded_requests ?? 0), 0),
    failedRequests: Math.max(Number(jobState?.failed_requests ?? 0), 0),
    outputFileId: typeof jobState?.output_file === 'string' && jobState.output_file
      ? jobState.output_file
      : null
  };
}

function isTerminalBatchStatus(status: string): boolean {
  return status === 'SUCCESS' || status === 'FAILED' || status === 'CANCELLED';
}

function parseMistralBatchResultText(resultsText: string): Map<string, string> {
  const results = new Map<string, string>();
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
    const pages = extractMarkdownSections(body);
    const text = pages.map(p => (typeof p === 'string' ? p.trim() : '')).filter(Boolean).join('\n\n');
    results.set(customId, cleanMarkdown(text));
  }
  return results;
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

export async function submitMistralBatchJob(
  files: string[],
  apiKey: string,
  modelName: string = 'mistral-ocr-latest',
  opts: MistralBatchSubmitOptions = {}
): Promise<{ jobId: string; totalRequests: number }> {
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

  try {
    const baseTemp = opts.tempRoot || os.tmpdir();
    await fs.promises.mkdir(baseTemp, { recursive: true }).catch(() => {});

    const manifestDir = opts.cacheDir || baseTemp;
    await fs.promises.mkdir(manifestDir, { recursive: true }).catch(() => {});
    batchPath = manifestFilePath(manifestDir);

    const preprocessed: Array<{ customId: string; uploadPath: string; filePath: string }> = [];
    const uploads: { customId: string; signedUrl: string; filePath: string }[] = [];

    await log(`Preprocessing ${files.length} file(s) before upload...`);
    for (const file of files) {
      await log(`Preprocessing ${path.basename(file)}...`);
      if (useSignal.aborted) throw abortError();

      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) throw new Error(`Input must be a file: ${file}`);
      if (!isMistralSupported(file)) throw new Error(`Unsupported file type for Mistral OCR: ${file}`);

      const customId = normalizeCustomId(file, baseInput);
      let cachedPath: string | null = null;
      if (opts.cacheDir) {
        const rel = baseInput ? path.relative(path.resolve(baseInput), path.resolve(file)) : path.basename(file);
        const relDir = path.dirname(rel);
        cachedPath = path.join(opts.cacheDir, relDir, `${path.basename(file, path.extname(file))}.png`);
        await fs.promises.mkdir(path.dirname(cachedPath), { recursive: true }).catch(() => {});
        const exists = await fs.promises.stat(cachedPath).then(() => true).catch(() => false);
        if (exists) {
          await log(`Reusing cached image for ${path.basename(file)} at ${cachedPath}`);
        } else {
          cachedPath = null;
        }
      }

      const prep = cachedPath
        ? { path: cachedPath, mime: 'image/png', cleanup: null }
        : await preprocessForMistral(file, opts.cacheDir, baseInput, baseTemp);
      if (!cachedPath && opts.cacheDir) {
        await log(`Cached preprocessed image for ${path.basename(file)} at ${prep.path}`);
      }
      if (prep.cleanup) cleanups.push(prep.cleanup);
      preprocessed.push({
        customId,
        uploadPath: prep.path,
        filePath: path.resolve(file)
      });
      if (cacheRoot && isPathInside(cacheRoot, prep.path)) {
        cachedTempFiles.add(path.resolve(prep.path));
      }
    }

    await log(`Finished preprocessing ${preprocessed.length} file(s); starting uploads...`);
    for (const prep of preprocessed) {
      if (useSignal.aborted) throw abortError();

      await log(`Uploading ${path.basename(prep.filePath)}...`);
      const { id } = await uploadFileToMistral(prep.uploadPath, apiKey, 'ocr', useSignal);
      await log(`Uploaded ${path.basename(prep.filePath)} as ${id}`);

      // Small delay to allow Mistral to process the uploaded file before requesting signed URL
      await sleep(500, useSignal);

      const signedUrl = await getSignedUrl(id, apiKey, useSignal);
      uploads.push({
        customId: prep.customId,
        signedUrl,
        filePath: prep.filePath
      });
    }

    await log(`Uploads complete. Creating batch manifest...`);
    const lines = uploads.map(u =>
      JSON.stringify({
        custom_id: u.customId,
        body: {
          document: { type: 'document_url', document_url: u.signedUrl },
          include_image_base64: false
        }
      })
    );
    await fs.promises.writeFile(batchPath, lines.join('\n'), 'utf-8');
    await log(`Batch JSONL written (${uploads.length} lines) at ${batchPath}`);

    const { id: batchFileId } = await uploadFileToMistral(batchPath, apiKey, 'batch', useSignal);
    await log(`Uploaded batch manifest ${batchFileId}`);
    const job = await createBatchJob(batchFileId, apiKey, modelName, useSignal);
    const jobId = String(job?.id || '');
    if (!jobId) {
      throw new Error('Mistral batch job creation returned no job id');
    }
    await log(`Created batch job ${jobId}`);
    uploadSucceeded = true;
    return { jobId, totalRequests: uploads.length };
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

export async function downloadMistralBatchResults(
  outputFileId: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  if (!outputFileId) {
    throw new Error('Missing output file id for Mistral batch results');
  }
  const useSignal = bindSignal(signal);
  try {
    const resultsText = await downloadFileContent(outputFileId, apiKey, useSignal);
    return parseMistralBatchResultText(resultsText);
  } finally {
    currentController = null;
    currentReject = null;
  }
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
        tempRoot: opts.tempRoot
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
        throw new Error(`Batch ${submission.jobId} succeeded but output file is missing`);
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
