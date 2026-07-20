// Per-output-folder "reviewed" flags, keyed by transcript file name. Applies
// to any transcript (audio or image, Mistral or not) — unlike Mistral
// confidence, this is a plain user-curated flag with nowhere else to live,
// so it gets its own small JSON file next to the outputs it describes.
import { fs, path as pathModule } from '../electron';

const REVIEW_STATUS_FILE = '.transcribeai-review-status.json';

export function reviewStatusPathForDir(dir: string): string {
  return pathModule.join(dir, REVIEW_STATUS_FILE);
}

export function loadReviewStatus(dir: string): Record<string, boolean> {
  try {
    const raw = JSON.parse(fs.readFileSync(reviewStatusPathForDir(dir), 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function saveReviewStatus(dir: string, status: Record<string, boolean>): void {
  try {
    fs.writeFileSync(reviewStatusPathForDir(dir), JSON.stringify(status), 'utf-8');
  } catch {
    // Non-critical UI preference; a failed write just means the flag
    // doesn't persist across restarts, not worth surfacing an error for.
  }
}
