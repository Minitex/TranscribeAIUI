// App-wide constants. Extracted verbatim from App.tsx so views/components can
// share them without importing the whole app shell.

export const AUDIO_MODEL_OPTIONS = [
  'voxtral-mini-latest',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'gemini-2.5-flash'
];
export const DEFAULT_AUDIO_MODEL = 'gemini-3.1-pro-preview';

export const IMAGE_MODEL_OPTIONS = [
  'mistral-ocr-latest',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'gemini-2.5-flash'
];
export const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash';
export const MISTRAL_BATCH_WORKER_OPTIONS = [1, 2, 3, 4, 5] as const;
export const MIN_MISTRAL_BATCH_WORKERS = MISTRAL_BATCH_WORKER_OPTIONS[0];
export const MAX_MISTRAL_BATCH_WORKERS =
  MISTRAL_BATCH_WORKER_OPTIONS[MISTRAL_BATCH_WORKER_OPTIONS.length - 1];
export const DEFAULT_MISTRAL_BATCH_PREPROCESS_WORKERS = 2;
export const DEFAULT_MISTRAL_BATCH_UPLOAD_WORKERS = 2;
export const DISPLAY_LOG_MAX_BYTES = 256 * 1024;
export const LIVE_LOG_REFRESH_INTERVAL_MS = 2000;
export const LIVE_TRANSCRIPT_REFRESH_INTERVAL_MS = 8000;
export const LIVE_BATCH_UI_REFRESH_INTERVAL_MS = 2000;
// UI timing
export const TOAST_DURATION_MS = 6000;
export const SAVED_BADGE_DURATION_MS = 2500;
export const TEMP_FILES_SUCCESS_MS = 3000;
export const TEMP_FILES_ERROR_MS = 5000;
export const LOG_SCROLL_DELAY_MS = 100;
export const UPDATE_CHECK_TIMEOUT_MS = 8000;
// Batch mode
export const BATCH_MODE_INFO = "Half price, but not instant — batch jobs run when Mistral has spare server capacity, usually finishing in about 2 hours (up to 24 for large queues). Best for many files rather than a few large ones; feel free to start another folder while you wait.";
// Layout
export const SIDEBAR_DEFAULT_WIDTH = 320;
export const SIDEBAR_MIN_WIDTH = 320;
// Hash routes (also mirrored in src/electron/main.ts)
export const ROUTE_SETTINGS = '#/settings';
export const ROUTE_BATCH_QUEUE = '#/batch-queue';

export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.jp2', '.tif', '.tiff', '.bmp', '.gif', '.webp', '.pdf'];
export const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma', '.mp4', '.webm', '.opus', '.aiff', '.aif'];
export const ACCESSIBLE_PDF_PREFIX = 'ACCESSIBLE_';

// Mistral pricing (mistral.ai/pricing/api, checked 2026-07). Batch audio rate
// isn't separately published — Mistral advertises a blanket "50% off" for
// batch across the API, so it's applied here the same as OCR's published
// batch rate; treat the audio batch figure as an estimate, not a quote.
export const MISTRAL_OCR_PRICE_PER_PAGE_DIRECT = 4 / 1000;
export const MISTRAL_OCR_PRICE_PER_PAGE_BATCH = 2 / 1000;
export const MISTRAL_AUDIO_PRICE_PER_MINUTE_DIRECT = 0.003;
export const MISTRAL_AUDIO_PRICE_PER_MINUTE_BATCH = 0.0015;
