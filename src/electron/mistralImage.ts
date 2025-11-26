import fs from 'fs';
import os from 'os';
import path from 'path';

let currentController: AbortController | null = null;
let currentReject: ((err: any) => void) | null = null;

const SUPPORTED_EXTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.gif']);

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
    const errText = await resp.text().catch(() => '');
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
  const resp = await fetch(`https://api.mistral.ai/v1/files/${fileId}/url`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const err: any = new Error(`Mistral signed URL failed: ${resp.status} ${resp.statusText} ${errText}`);
    err.status = resp.status;
    throw err;
  }
  const json = await resp.json();
  const url = json?.url;
  if (!url) throw new Error('Mistral signed URL response missing url');
  return url;
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
    const errText = await resp.text().catch(() => '');
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
    const errText = await resp.text().catch(() => '');
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
    const errText = await resp.text().catch(() => '');
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
  const data = await fs.promises.readFile(prep.path);
  const base64 = data.toString('base64');
  const mimeType = prep.mime;

  const body = {
    model: modelName,
    document: {
      type: 'inline',
      data: base64,
      mime_type: mimeType
    },
    include_image_base64: false
  };

  currentController = new AbortController();

  return await new Promise<string>(async (resolve, reject) => {
    currentReject = reject;
    try {
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
        const errText = await resp.text().catch(() => '');
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
      resolve(cleanMarkdown(raw));
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

export async function transcribeImageMistralBatch(
  files: string[],
  apiKey: string,
  modelName: string = 'mistral-ocr-latest',
  opts: { baseInput?: string; pollIntervalMs?: number; logger?: (msg: string) => void | Promise<void>; signal?: AbortSignal; cacheDir?: string; tempRoot?: string } = {}
): Promise<Map<string, string>> {
  if (!files.length) {
    throw new Error('No files provided for Mistral batch OCR');
  }

  const baseInput = opts.baseInput ? path.resolve(opts.baseInput) : path.dirname(path.resolve(files[0]));
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const logFn = opts.logger ?? (() => {});
  const log = async (msg: string) => { try { await logFn(`[mistral-batch] ${msg}`); } catch {} };

  currentController = new AbortController();
  const useSignal = (() => {
    if (!opts.signal) return currentController!.signal;
    if (opts.signal.aborted) return opts.signal;
    opts.signal.addEventListener('abort', () => currentController?.abort(), { once: true });
    return opts.signal;
  })();

  return await new Promise<Map<string, string>>(async (resolve, reject) => {
    currentReject = reject;
    const cleanups: Array<() => Promise<void>> = [];
    let succeeded = false;
    const preprocessed: Array<{ customId: string; uploadPath: string; filePath: string }> = [];
    const uploads: { customId: string; signedUrl: string; filePath: string }[] = [];
    let batchPath: string | null = null;
    try {
      const baseTemp = opts.tempRoot || os.tmpdir();
      await fs.promises.mkdir(baseTemp, { recursive: true }).catch(() => {});

      // The manifest we will ultimately upload; also used for resume
      const manifestDir = opts.cacheDir || baseTemp;
      await fs.promises.mkdir(manifestDir, { recursive: true }).catch(() => {});
      batchPath = path.join(manifestDir, 'ocr_batch.jsonl');

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
      }

      // Load any prior manifest entries so we can reuse already-uploaded files
      const existingLines: string[] = [];
      const resumeMap = new Map<string, { signedUrl: string; filePath: string }>();
      const expectedIds = new Set(preprocessed.map(p => p.customId));
      if (await fs.promises.stat(batchPath).then(() => true).catch(() => false)) {
        const text = await fs.promises.readFile(batchPath, 'utf-8').catch(() => '');
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let rec: any;
          try {
            rec = JSON.parse(trimmed);
          } catch {
            continue;
          }
          const cid = typeof rec?.custom_id === 'string' ? rec.custom_id : undefined;
          const docUrl = rec?.body?.document?.document_url;
          if (!cid || !expectedIds.has(cid) || typeof docUrl !== 'string' || !docUrl) continue;
          resumeMap.set(cid, { signedUrl: docUrl, filePath: rec?.body?.file_path || '' });
          existingLines.push(trimmed);
        }
        if (existingLines.length) {
          await log(`Found ${existingLines.length} previously uploaded file(s); will reuse them`);
        }
      }

      // Rewrite manifest with only relevant entries for this run
      await fs.promises.writeFile(batchPath, existingLines.join('\n'), 'utf-8').catch(() => {});

      await log(`Finished preprocessing ${preprocessed.length} file(s); starting uploads...`);

      // Ensure preprocessing finished before any upload starts
      for (const prep of preprocessed) {
        if (useSignal.aborted) throw abortError();
        const resume = resumeMap.get(prep.customId);
        if (resume) {
          await log(`Reusing uploaded ${path.basename(prep.filePath)}`);
          uploads.push({
            customId: prep.customId,
            signedUrl: resume.signedUrl,
            filePath: prep.filePath
          });
          continue;
        }

        await log(`Uploading ${path.basename(prep.filePath)}...`);
        const { id } = await uploadFileToMistral(prep.uploadPath, apiKey, 'ocr', useSignal);
        await log(`Uploaded ${path.basename(prep.filePath)} as ${id}`);
        const signedUrl = await getSignedUrl(id, apiKey, useSignal);
        uploads.push({
          customId: prep.customId,
          signedUrl,
          filePath: prep.filePath
        });

        // Append to manifest immediately so we can resume without reupload
        const line = JSON.stringify({
          custom_id: prep.customId,
          body: {
            document: { type: 'document_url', document_url: signedUrl },
            file_path: prep.filePath
          }
        });
        const needsNewline = await fs.promises.stat(batchPath).then(stat => stat.size > 0).catch(() => false);
        await fs.promises.appendFile(batchPath, (needsNewline ? '\n' : '') + line, 'utf-8').catch(() => {});
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
      await log(`Batch JSONL cached at: ${batchPath}`);

      await log(`Batch JSONL written (${uploads.length} lines) at ${batchPath}`);
      const { id: batchFileId } = await uploadFileToMistral(batchPath, apiKey, 'batch', useSignal);
      await log(`Uploaded batch manifest ${batchFileId}`);
      const job = await createBatchJob(batchFileId, apiKey, modelName, useSignal);
      await log(`Created batch job ${job?.id || '<unknown>'}`);

      let jobState = job;
      while (!['SUCCESS', 'FAILED', 'CANCELLED'].includes(jobState?.status)) {
        await sleep(pollIntervalMs, useSignal);
        jobState = await fetchBatchJob(job.id, apiKey, useSignal);
        const done = (jobState?.succeeded_requests || 0) + (jobState?.failed_requests || 0);
        const total = Math.max(jobState?.total_requests || uploads.length, 1);
        await log(`Job ${job.id} status=${jobState?.status} ${done}/${total}`);
      }

      if (jobState.status !== 'SUCCESS') {
        throw new Error(`Batch ended with status ${jobState.status}`);
      }

      await log(`Job ${jobState.id} succeeded, downloading results ${jobState.output_file}`);
      const resultsText = await downloadFileContent(jobState.output_file, apiKey, useSignal);
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

      succeeded = true;
      resolve(results);
    } catch (err) {
      reject(err);
    } finally {
      currentController = null;
      currentReject = null;
      // Cleanup temp JSONL dirs and transient preprocess files; keep cacheDir intact
      for (const clean of cleanups) {
        clean().catch(() => {});
      }
      // Match prior behavior: only clear cache after successful completion
      if (succeeded && opts.cacheDir) {
        fs.promises.rm(opts.cacheDir, { recursive: true, force: true }).catch(() => {});
      }
      if (succeeded && batchPath) {
        fs.promises.rm(batchPath, { force: true }).catch(() => {});
      }
    }
  });
}
