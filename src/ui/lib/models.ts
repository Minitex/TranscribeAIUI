// Model-name and worker-count resolution helpers.
import { MAX_MISTRAL_BATCH_WORKERS, MIN_MISTRAL_BATCH_WORKERS } from './constants';

export function resolveSupportedModel(
  value: string | null | undefined,
  options: readonly string[],
  fallback: string
): string {
  if (typeof value === 'string' && options.includes(value)) {
    return value;
  }
  return fallback;
}

export function resolveWorkerCount(
  value: string | number | null | undefined,
  fallback: number
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_MISTRAL_BATCH_WORKERS, Math.max(MIN_MISTRAL_BATCH_WORKERS, Math.floor(parsed)));
}

export function getNextWorkerCount(currentValue: number): number {
  return Math.min(
    MAX_MISTRAL_BATCH_WORKERS,
    resolveWorkerCount(currentValue, MAX_MISTRAL_BATCH_WORKERS) + 1
  );
}

export function getPrevWorkerCount(currentValue: number): number {
  return Math.max(
    MIN_MISTRAL_BATCH_WORKERS,
    resolveWorkerCount(currentValue, MIN_MISTRAL_BATCH_WORKERS) - 1
  );
}
