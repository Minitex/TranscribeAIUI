import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import { Worker, isMainThread, parentPort } from 'worker_threads';

// Rasterizes a PDF's pages to PNGs for the OCR review modal's preview pane —
// this codebase has pdf-lib for PDF *manipulation* but nothing that renders a
// page to pixels. Uses pdfjs-dist (Mozilla's PDF renderer) with
// @napi-rs/canvas as the pixel surface — both ship prebuilt binaries for
// mac/Windows/Linux, so no native build toolchain is required at install
// time.
//
// Two earlier versions of this module didn't work out:
// 1. Drove Electron's own Chromium/PDFium via a hidden BrowserWindow per
//    page. Crashed the whole process (SIGTRAP) the second time any window
//    loaded a local PDF, and reusing one window across pages hung
//    indefinitely on a same-document #page=N navigation. Reproduced
//    consistently, not a fluke.
// 2. Called pdfjs-dist directly from Electron's main thread. pdfjs's
//    Node-vs-browser environment detection doesn't cleanly recognize
//    Electron's main process (it has `process.versions.electron` set but
//    isn't a plain Node process either), so it fell into a "fake worker"
//    setup path meant for bundled-browser use that hung indefinitely partway
//    through the worker handshake.
//
// Running the pdfjs/canvas work inside a real Node worker_thread (same
// pattern as markdownRenderWorker.ts) sidesteps both: no windows, and inside
// a worker_threads thread pdfjs's environment detection resolves the same
// way it does in plain Node.

const RASTERIZE_CALL_CONCURRENCY = 2;

function pagePngPath(outDir: string, pageNumber: number): string {
  return path.join(outDir, `page-${pageNumber}.png`);
}

async function existingCachedPages(outDir: string, pageCount: number): Promise<string[] | null> {
  const candidates = Array.from({ length: pageCount }, (_, i) => pagePngPath(outDir, i + 1));
  for (const candidate of candidates) {
    const exists = await fs.promises.access(candidate, fs.constants.F_OK).then(() => true, () => false);
    if (!exists) return null;
  }
  return candidates;
}

// ============================================================================
// Worker-thread entry point. Only runs inside the spawned worker thread --
// when this module is imported normally by main.ts, isMainThread is true and
// none of this executes (the pdfjs-dist/@napi-rs/canvas imports below are
// dynamic so the main thread never has to load them at all).
// ============================================================================

interface RasterizeRequest {
  id: number;
  pdfPath: string;
  outDir: string;
  pageCount: number;
}

interface RasterizeResponse {
  id: number;
  paths?: string[];
  error?: string;
}

async function renderPagesInWorker(req: RasterizeRequest): Promise<string[]> {
  const require = createRequire(import.meta.url);
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');

  const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  // workerSrc goes through dynamic import(), which accepts a file:// URL.
  GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(pdfjsDir, 'legacy', 'build', 'pdf.worker.mjs')).href;
  // standardFontDataUrl and wasmUrl, on the other hand, go through pdfjs's
  // own Node fetch helper, which just does `fs.readFile(url)` on whatever
  // string it's given -- fs.readFile treats a "file://..." string as a
  // literal relative path (looking for a folder literally named "file:"),
  // not a URL to resolve, so it always failed with these as file:// URLs.
  // A plain filesystem path is what fs.readFile actually needs here.
  //
  // pdfjs's own factory-url validation also hardcodes checking for a
  // trailing "/" (not path.sep) regardless of OS -- on Windows path.sep is
  // "\", which fails that check ("must include trailing slash") even though
  // the path itself is otherwise valid. Node's fs happily accepts forward
  // slashes in Windows paths too, so a literal "/" works on every platform.
  const standardFontDataUrl = path.join(pdfjsDir, 'standard_fonts') + '/';
  // JBIG2/OpenJPEG (the bi-level and JPEG2000 codecs real scanners commonly
  // produce) decode via WASM modules pdfjs ships in its own wasm/ dir --
  // without pointing at it, pdfjs defaults to a bare "wasm" string that can't
  // resolve here, so those images silently fail to decode and the page comes
  // out blank underneath the (independently-sourced) OCR block overlays.
  const wasmUrl = path.join(pdfjsDir, 'wasm') + '/';

  await fs.promises.mkdir(req.outDir, { recursive: true });
  const data = new Uint8Array(await fs.promises.readFile(req.pdfPath));
  const loadingTask = getDocument({ data, standardFontDataUrl, wasmUrl, disableFontFace: true });
  const pdf = await loadingTask.promise;
  try {
    const outPaths: string[] = [];
    const RENDER_SCALE = 2.0; // sharp enough to zoom into; the modal scales display size via CSS
    for (let pageNumber = 1; pageNumber <= req.pageCount; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext('2d');
      const renderTask = page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport
      });
      await renderTask.promise;
      const outPath = pagePngPath(req.outDir, pageNumber);
      await fs.promises.writeFile(outPath, await canvas.encode('png'));
      page.cleanup();
      outPaths.push(outPath);
    }
    return outPaths;
  } finally {
    await loadingTask.destroy();
  }
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  // Each request is handled independently (not awaited before the next
  // 'message' event is processed), so responses can complete out of order
  // when the worker is given more than one concurrent request -- every
  // response carries the same `id` its request came in with instead of
  // relying on send order.
  port.on('message', (req: RasterizeRequest) => {
    renderPagesInWorker(req)
      .then(paths => port.postMessage({ id: req.id, paths } satisfies RasterizeResponse))
      .catch(err => port.postMessage({ id: req.id, error: err instanceof Error ? err.message : String(err) } satisfies RasterizeResponse));
  });
}

// ============================================================================
// Main-thread client. Lazily spawns a single shared worker, reused across
// calls, matching each response to its caller by request id. Concurrency is
// capped since rendering is CPU-bound native work -- a big multi-page PDF
// shouldn't peg every core on a weak machine.
// ============================================================================

let sharedWorker: Worker | null = null;
let nextRequestId = 0;
const pendingCallbacks = new Map<number, { resolve: (paths: string[]) => void; reject: (err: unknown) => void }>();

function failAllPending(err: unknown): void {
  for (const callback of pendingCallbacks.values()) callback.reject(err);
  pendingCallbacks.clear();
}

function getSharedWorker(): Worker {
  if (sharedWorker) return sharedWorker;

  const worker = new Worker(new URL(import.meta.url));
  // worker.unref() alone doesn't reliably let the process exit -- Node keeps
  // an internal MessagePort handle alive as long as the Worker instance
  // exists, unref or not. So once every in-flight request settles, terminate
  // the worker outright instead of keeping it "warm" -- rasterizing isn't a
  // hot path (once per PDF review open), so respawning on the next call is
  // cheap, and this guarantees Electron/a plain script/test can always exit
  // right after its last call settles.
  //
  // worker.terminate() itself fires 'exit', asynchronously, some time after
  // this call returns -- by then a *newer* generation may already be handling
  // its own in-flight request. `retiredDeliberately` distinguishes "this
  // exact worker was retired on purpose, ignore its exit" from "this worker
  // died unexpectedly (crash), fail whatever it was working on".
  let retiredDeliberately = false;
  worker.unref();

  worker.on('message', (response: RasterizeResponse) => {
    const callback = pendingCallbacks.get(response.id);
    pendingCallbacks.delete(response.id);
    if (pendingCallbacks.size === 0 && sharedWorker === worker) {
      sharedWorker = null;
      retiredDeliberately = true;
      worker.terminate();
    }
    if (!callback) return;
    if (response.error) callback.reject(new Error(response.error));
    else callback.resolve(response.paths ?? []);
  });
  worker.on('error', (err) => {
    if (sharedWorker === worker) sharedWorker = null;
    failAllPending(err);
  });
  worker.on('exit', (code) => {
    if (sharedWorker === worker) sharedWorker = null;
    if (!retiredDeliberately && pendingCallbacks.size) {
      failAllPending(new Error(`PDF rasterize worker exited unexpectedly with code ${code}`));
    }
  });

  sharedWorker = worker;
  return worker;
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

const rasterizeLimiter = createConcurrencyLimiter(RASTERIZE_CALL_CONCURRENCY);

// Renders every page of `pdfPath` to outDir/page-<N>.png (1-indexed) and
// returns the resulting paths in page order. Cached: if outDir already has
// all `pageCount` PNGs, returns them without re-rendering (no worker spawn
// needed on a cache hit).
export async function rasterizePdfPages(pdfPath: string, outDir: string, pageCount: number): Promise<string[]> {
  if (pageCount <= 0) return [];
  const cached = await existingCachedPages(outDir, pageCount);
  if (cached) return cached;

  return rasterizeLimiter(() => new Promise<string[]>((resolve, reject) => {
    const worker = getSharedWorker();
    const id = nextRequestId++;
    pendingCallbacks.set(id, { resolve, reject });
    worker.postMessage({ id, pdfPath, outDir, pageCount } satisfies RasterizeRequest);
  }));
}
