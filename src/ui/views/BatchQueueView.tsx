import { useState, useEffect, useCallback, useMemo } from 'react';
import { FaInfoCircle, FaTrash } from 'react-icons/fa';
import { ipcRenderer } from '../electron';
import type { MistralBatchQueueRow } from '../lib/types';

export default function BatchQueueView() {
  const [rows, setRows] = useState<MistralBatchQueueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [removingKey, setRemovingKey] = useState('');

  const loadRows = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const queue = await ipcRenderer.invoke('get-mistral-batch-queue') as MistralBatchQueueRow[];
      setRows(Array.isArray(queue) ? queue : []);
      setError('');
    } catch (err) {
      setRows([]);
      setError(err instanceof Error && err.message ? err.message : 'Failed to load batch queue.');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRows(true);
    const onFocus = () => {
      void loadRows(false);
    };
    const intervalId = window.setInterval(() => {
      void loadRows(false);
    }, 5000);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadRows]);

  const selectFolder = useCallback(
    async (row: MistralBatchQueueRow) => {
      const key = `${row.inputPath}::${row.outputDir}`;
      setSelectedKey(key);
      setError('');
      try {
        const result = await ipcRenderer.invoke('select-mistral-batch-folder', {
          inputPath: row.inputPath,
          outputDir: row.outputDir,
          modelName: row.modelName
        }) as { ok?: boolean; error?: string };
        if (!result?.ok) {
          setError(result?.error || 'Failed to select queue item.');
          return;
        }
        window.close();
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : 'Failed to select queue item.');
      } finally {
        setSelectedKey('');
      }
    },
    []
  );

  const removeRow = useCallback(
    async (row: MistralBatchQueueRow, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!window.confirm(`Remove this saved batch folder from the queue?\n\n${row.inputPath}`)) return;
      const key = `${row.inputPath}::${row.outputDir}`;
      setRemovingKey(key);
      setError('');
      try {
        const result = await ipcRenderer.invoke('remove-mistral-batch-folder', {
          inputPath: row.inputPath,
          outputDir: row.outputDir,
          modelName: row.modelName
        }) as { ok?: boolean; error?: string };
        if (!result?.ok) {
          setError(result?.error || 'Failed to remove queue item.');
          return;
        }
        await loadRows(false);
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : 'Failed to remove queue item.');
      } finally {
        setRemovingKey('');
      }
    },
    [loadRows]
  );

  const formatTime = (timestampMs: number | null) => {
    if (!timestampMs) return '—';
    return new Date(timestampMs).toLocaleString();
  };

  const summary = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        acc.uploaded += row.uploaded;
        acc.processing += row.processing;
        acc.completed += row.completed;
        acc.failed += row.failed;
        return acc;
      },
      { uploaded: 0, processing: 0, completed: 0, failed: 0 }
    );
  }, [rows]);

  return (
    <div className="settings-container batch-queue-page">
      <h2 className="batch-queue-title">Mistral Batch Queue</h2>
      <div className="settings-scroll">
        {!!rows.length && (
          <div className="batch-queue-summary">
            <div className="batch-queue-summary-card">
              <span>Collections</span>
              <strong>{rows.length}</strong>
            </div>
            <div className="batch-queue-summary-card">
              <span>Uploaded</span>
              <strong>{summary.uploaded}</strong>
            </div>
            <div className="batch-queue-summary-card">
              <span>Processing</span>
              <strong>{summary.processing}</strong>
            </div>
            <div className="batch-queue-summary-card">
              <span>Completed</span>
              <strong>{summary.completed}</strong>
            </div>
          </div>
        )}

        {error && <div className="batch-queue-error">{error}</div>}

        {!rows.length && !loading && (
          <div className="batch-queue-empty">
            No saved batch folders.
          </div>
        )}

        <div className="batch-queue-list">
          {rows.map(row => {
            const key = `${row.inputPath}::${row.outputDir}`;
            const selecting = selectedKey === key;
            const removing = removingKey === key;
            return (
              <div
                key={key}
                role="button"
                tabIndex={selecting ? -1 : 0}
                onClick={() => { if (!selecting) selectFolder(row); }}
                onKeyDown={e => {
                  if ((e.key === 'Enter' || e.key === ' ') && !selecting) {
                    e.preventDefault();
                    selectFolder(row);
                  }
                }}
                aria-disabled={selecting}
                className={`batch-queue-item${selecting ? ' disabled' : ''}`}
                title={`Load this folder pair in ${row.modelName.toLowerCase().includes('voxtral') ? 'Audio' : 'Image'} mode`}
              >
                <div className="batch-queue-item-top">
                  <span className="batch-queue-item-top-left">
                    <span className="batch-queue-kind">
                      {row.modelName.toLowerCase().includes('voxtral') ? 'Audio' : 'Image'}
                    </span>
                    <span className="batch-queue-model">{row.modelName}</span>
                  </span>
                  <span className="batch-queue-item-top-right">
                    <span className="batch-queue-open-hint">
                      {selecting ? 'Opening…' : 'Click to open'}
                    </span>
                    <button
                      type="button"
                      className="batch-queue-remove-btn"
                      onClick={e => removeRow(row, e)}
                      disabled={removing}
                      aria-label="Remove from batch queue"
                      title="Remove from batch queue"
                    >
                      <FaTrash size={12} />
                    </button>
                  </span>
                </div>
                <div className="batch-queue-path-row">
                  <span>Input</span>
                  <code>{row.inputPath}</code>
                </div>
                <div className="batch-queue-path-row">
                  <span>Output</span>
                  <code>{row.outputDir}</code>
                </div>
                <div className="batch-queue-pill-row">
                  <span className="batch-queue-pill uploaded">{`Uploaded ${row.uploaded}`}</span>
                  <span className="batch-queue-pill processing">{`Processing ${row.processing}`}</span>
                  <span className="batch-queue-pill completed">{`Completed ${row.completed}`}</span>
                  {row.failed > 0 && <span className="batch-queue-pill failed">{`Failed ${row.failed}`}</span>}
                </div>
                <div className="batch-queue-times">
                  <div>
                    <span>Oldest start</span>
                    <strong>{formatTime(row.oldestPendingStartMs)}</strong>
                  </div>
                  <div>
                    <span>Check back</span>
                    <strong>{formatTime(row.checkBackAtMs)}</strong>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {!!rows.length && summary.failed > 0 && (
          <div className="batch-queue-footnote">
            Failed jobs remain in the queue until retried or cleared from temp files.
          </div>
        )}
      </div>
      <div className="settings-buttons batch-queue-actions">
        <div className="batch-queue-help-tooltip">
          <button
            type="button"
            className="batch-queue-help-trigger"
            aria-label="Why are my batches taking so long to process?"
          >
            <FaInfoCircle size={13} />
            <span>Why are my batches taking so long to process?</span>
          </button>
          <div className="batch-queue-help-box" role="tooltip">
            Batch processing is designed for non-urgent work and runs when servers have spare capacity. Batches typically complete in around 2 hours, but can take up to 24 hours. In the meantime, you can work on another image collection and check back later.
          </div>
        </div>
        <button className="btn cancel" onClick={() => window.close()}>
          Close
        </button>
      </div>
    </div>
  );
}
