// Error/cancellation helpers shared across the renderer.

export function getErrorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return 'Unknown error';
}

// Mirrors the backend cancellation contract (see createCancelledError /
// isCancellationError in src/electron/main.ts).
export const CANCEL_SENTINEL = 'terminated by user';

export function isCancellation(e: unknown): boolean {
  if (e && typeof e === 'object') {
    const o = e as { cancelled?: unknown; name?: unknown; signal?: unknown };
    if (o.cancelled === true || o.name === 'AbortError' || o.signal === 'SIGTERM') return true;
  }
  return getErrorMessage(e).includes(CANCEL_SENTINEL);
}
