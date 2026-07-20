import React, { useEffect, useMemo, useState } from 'react';
import { fs } from '../electron';
import type { Transcript } from './AudioTranscriber';

interface BatchFindReplaceModalProps {
  isOpen: boolean;
  files: Transcript[];
  onClose(): void;
  onDone(): void;
}

// Debounced so a batch of hundreds of files doesn't re-read every .txt on
// every keystroke — that used to freeze the whole app on a slow disk.
const PREVIEW_DEBOUNCE_MS = 300;

// OCR errors are systematic — the same misread repeats hundreds of times
// across a batch (a newspaper run, a folder of contracts). This runs a
// literal (non-regex) find/replace across every .txt in the current list,
// since regex UI is easy to get wrong on a destructive, unreviewable-per-file
// bulk edit — plain substring matching covers the actual "tbe" -> "the" case.
const BatchFindReplaceModal: React.FC<BatchFindReplaceModalProps> = ({ isOpen, files, onClose, onDone }) => {
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState<{ matchingFiles: number; totalMatches: number } | null>(null);

  const txtFiles = useMemo(() => files.filter(f => f.name.toLowerCase().endsWith('.txt')), [files]);

  useEffect(() => {
    if (!findText) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const run = async () => {
        // Capped concurrency — a folder of hundreds/thousands of .txt files
        // would otherwise fire that many concurrent file reads on every
        // debounced keystroke and stall the app, especially on slower disks.
        const PREVIEW_CONCURRENCY = 6;
        const counts: number[] = [];
        for (let i = 0; i < txtFiles.length; i += PREVIEW_CONCURRENCY) {
          if (cancelled) return;
          const chunk = txtFiles.slice(i, i + PREVIEW_CONCURRENCY);
          const chunkCounts = await Promise.all(
            chunk.map(async f => {
              try {
                const content = await fs.promises.readFile(f.path, 'utf-8');
                return content.split(findText).length - 1;
              } catch {
                return 0;
              }
            })
          );
          counts.push(...chunkCounts);
        }
        if (cancelled) return;
        setPreview({
          matchingFiles: counts.filter(c => c > 0).length,
          totalMatches: counts.reduce((a, b) => a + b, 0)
        });
      };
      void run();
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [findText, txtFiles]);

  if (!isOpen) return null;

  const handleReplaceAll = async () => {
    if (!preview?.totalMatches) return;
    if (!window.confirm(`Replace ${preview.totalMatches} occurrence(s) across ${preview.matchingFiles} file(s)? This cannot be undone.`)) {
      return;
    }
    setWorking(true);
    let changedFiles = 0;
    const errors: string[] = [];
    for (const f of txtFiles) {
      try {
        const content = await fs.promises.readFile(f.path, 'utf-8');
        if (!content.includes(findText)) continue;
        await fs.promises.writeFile(f.path, content.split(findText).join(replaceText), 'utf-8');
        changedFiles += 1;
      } catch (err) {
        errors.push(f.name);
      }
    }
    setWorking(false);
    if (errors.length) {
      setStatus({ kind: 'error', message: `Updated ${changedFiles} file(s), failed on: ${errors.join(', ')}` });
    } else {
      setStatus({ kind: 'ok', message: `Updated ${changedFiles} file(s).` });
    }
    setFindText('');
    setReplaceText('');
    onDone();
  };

  return (
    <div className="folder-picker-overlay" role="dialog" aria-modal="true">
      <div className="folder-picker-modal" style={{ height: 'auto', width: 'min(560px, 95vw)' }}>
        <div className="folder-picker-body">
          <div className="folder-picker-header">
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Find &amp; Replace Across Batch</h3>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Applies to all {txtFiles.length} .txt file{txtFiles.length === 1 ? '' : 's'} in the current list.
            </p>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span>Find</span>
            <input
              value={findText}
              onChange={e => setFindText(e.target.value)}
              autoFocus
              style={{ background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-light)', borderRadius: 'var(--radius-sm)', padding: '0.5rem' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span>Replace with</span>
            <input
              value={replaceText}
              onChange={e => setReplaceText(e.target.value)}
              style={{ background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-light)', borderRadius: 'var(--radius-sm)', padding: '0.5rem' }}
            />
          </label>
          {preview && (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              {preview.totalMatches
                ? `${preview.totalMatches} match(es) across ${preview.matchingFiles} file(s)`
                : 'No matches'}
            </div>
          )}
          {status && (
            <div style={{ fontSize: '0.85rem', color: status.kind === 'ok' ? 'var(--success)' : 'var(--danger)' }}>
              {status.message}
            </div>
          )}
        </div>
        <div className="folder-picker-footer">
          <button type="button" onClick={onClose}>Close</button>
          <button
            type="button"
            className="primary"
            onClick={handleReplaceAll}
            disabled={working || !preview?.totalMatches}
          >
            {working ? 'Replacing…' : 'Replace All'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default BatchFindReplaceModal;
