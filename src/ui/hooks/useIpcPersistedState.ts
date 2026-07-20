import { useEffect, useRef, useState } from 'react';
import { ipcRenderer } from '../electron';

type PersistOptions<T> = {
  /** ipcMain channel that returns the stored value, e.g. 'get-active-mode' */
  getChannel: string;
  /** ipcMain channel that persists the value, e.g. 'set-active-mode' */
  setChannel: string;
  /** localStorage key used as a fallback when ipc is unavailable */
  storageKey: string;
  /** initial value used before hydration completes */
  initial: T;
  /** validate/coerce a raw value (from ipc or localStorage) to T, or undefined if invalid */
  parse: (raw: unknown) => T | undefined;
  /** serialize T for localStorage (defaults to String) */
  serialize?: (value: T) => string;
};

/**
 * Loads a value from an ipcMain getter (falling back to localStorage), and
 * persists every change back to both ipcMain and localStorage. Persisting is
 * gated until the initial load finishes so we never overwrite stored data with
 * the `initial` placeholder.
 */
export function useIpcPersistedState<T>(
  opts: PersistOptions<T>
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const { getChannel, setChannel, storageKey, initial, parse } = opts;
  const serialize = opts.serialize ?? ((v: T) => String(v));
  const [value, setValue] = useState<T>(initial);
  const loadedRef = useRef(false);

  const readLocal = (): T | undefined => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw == null ? undefined : parse(raw);
    } catch {
      return undefined;
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await ipcRenderer.invoke(getChannel);
        const parsed = parse(stored) ?? readLocal();
        if (!cancelled && parsed !== undefined) setValue(parsed);
      } catch {
        const fallback = readLocal();
        if (!cancelled && fallback !== undefined) setValue(fallback);
      } finally {
        if (!cancelled) loadedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loadedRef.current) return;
    ipcRenderer.invoke(setChannel, value).catch(() => {});
    try {
      localStorage.setItem(storageKey, serialize(value));
    } catch {
      /* localStorage unavailable; ipc store is the source of truth */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return [value, setValue];
}
