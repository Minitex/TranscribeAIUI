import fs from 'fs';
import os from 'os';
import path from 'path';

let currentController: AbortController | null = null;
let currentReject: ((err: any) => void) | null = null;

const MAX_DIMENSION = 4096;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const loggedTempDirs = new Set<string>();

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
    default: return 'application/octet-stream';
  }
}

export function cancelGeminiRequest() {
  if (currentController) {
    currentController.abort();
    currentController = null;
  }
}

function parseTextFromResponse(json: any): string {
  try {
    const cand = json?.candidates?.[0];
    const parts = cand?.content?.parts;
    if (Array.isArray(parts)) {
      const texts = parts
        .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
        .filter(Boolean);
      if (texts.length) return texts.join('\n');
    }
  } catch {}
  return '';
}

async function preprocessForGemini(
  filePath: string,
  cacheDir?: string,
  tempRoot?: string
): Promise<{ path: string; mime: string; cleanup: (() => Promise<void>) | null }> {
  let sharpMod: any;
  try {
    sharpMod = await import('sharp');
  } catch {
    return { path: filePath, mime: mimeFor(filePath), cleanup: null };
  }
  const sharp = sharpMod.default ?? sharpMod;
  const ext = path.extname(filePath).toLowerCase();

  try {
    const stat = await fs.promises.stat(filePath);
    const img = sharp(filePath, { failOnError: false });
    const meta = await img.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const needsResize = width > MAX_DIMENSION || height > MAX_DIMENSION;
    const needsReencode = ext === '.tif' || ext === '.tiff' || stat.size > MAX_FILE_BYTES;

    if (!needsResize && !needsReencode && !cacheDir) {
      return { path: filePath, mime: mimeFor(filePath), cleanup: null };
    }

    let outDir = cacheDir;
    let tempDir: string | null = null;
    const baseTemp = tempRoot || os.tmpdir();
    if (!outDir) {
      await fs.promises.mkdir(baseTemp, { recursive: true }).catch(() => {});
      tempDir = await fs.promises.mkdtemp(path.join(baseTemp, 'gemini-prep-'));
      outDir = tempDir;
    }

    await fs.promises.mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, `${path.basename(filePath, ext)}.png`);

    if (cacheDir && await fs.promises.stat(outPath).then(() => true).catch(() => false)) {
      return { path: outPath, mime: 'image/png', cleanup: null };
    }

    const transformer = needsResize
      ? img.resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true }).png()
      : img.png();
    await transformer.toFile(outPath);

    return {
      path: outPath,
      mime: 'image/png',
      cleanup: async () => {
        if (tempDir) {
          await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    };
  } catch {
    return { path: filePath, mime: mimeFor(filePath), cleanup: null };
  }
}

export async function transcribeImageGemini(
  filePath: string,
  prompt: string,
  modelName: string,
  apiKey: string,
  opts: { signal?: AbortSignal; logger?: (msg: string) => void | Promise<void>; cacheDir?: string; tempRoot?: string } = {}
): Promise<string> {
  currentController = new AbortController();
  const useSignal = (() => {
    const provided = opts.signal;
    if (!provided) return currentController!.signal;
    if (provided.aborted) {
      currentController!.abort();
      return provided;
    }
    provided.addEventListener('abort', () => currentController?.abort(), { once: true });
    return provided;
  })();

  return await new Promise<string>(async (resolve, reject) => {
    currentReject = reject;
    let cleanup: (() => Promise<void>) | null = null;
    let succeeded = false;
    try {
      if (useSignal.aborted) throw abortError();
      const prep = await preprocessForGemini(filePath, opts.cacheDir, opts.tempRoot);
      if (opts.logger) {
        const tmpDir = path.dirname(prep.path);
        if (!loggedTempDirs.has(tmpDir)) {
          loggedTempDirs.add(tmpDir);
          await Promise.resolve(opts.logger(`[INFO] Gemini temp images will be cached at: ${tmpDir}`));
        }
      }
      cleanup = prep.cleanup;
      const data = await fs.promises.readFile(prep.path);
      const base64 = data.toString('base64');
      const mimeType = prep.mime;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
      const body = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inlineData: { data: base64, mimeType } }
            ]
          }
        ],
        generationConfig: { responseMimeType: 'text/plain' }
      };

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(body),
        signal: useSignal
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        const err: any = new Error(`Gemini request failed: ${resp.status} ${resp.statusText} ${errText}`);
        err.status = resp.status;
        throw err;
      }

      const json = await resp.json();
      const text = parseTextFromResponse(json);
      succeeded = true;
      resolve(text ?? '');
    } catch (err) {
      reject(err);
    } finally {
      if (cleanup) {
        cleanup().catch(() => {});
      }
      if (succeeded && opts.cacheDir) {
        fs.promises.rm(opts.cacheDir, { recursive: true, force: true }).catch(() => {});
      }
      currentController = null;
      currentReject = null;
    }
  });
}
