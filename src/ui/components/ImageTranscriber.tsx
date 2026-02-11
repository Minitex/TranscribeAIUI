// src/components/ImageTranscriber.tsx
import React from 'react';
import {
  FaFileImage,
  FaFolderOpen,
  FaListUl,
  FaMicrophone,
  FaTimesCircle
} from 'react-icons/fa';

interface ImageTranscriberProps {
  inputPath: string;
  outputDir: string;
  isTranscribing: boolean;
  mistralMode: boolean;
  recursive: boolean;
  batchEnabled: boolean;
  batchSize: number;
  inputIsDirectory: boolean;
  batchStats: {
    uploaded: number;
    processing: number;
    completed: number;
    failed: number;
    total: number;
  } | null;
  onSelectInput(): void;
  onSelectOutput(): void;
  onClearInput(): void;
  onClearOutput(): void;
  onToggleRecursive(): void;
  onToggleBatch(): void;
  onBatchSizeChange(size: number): void;
  onOpenBatchQueue(): void;
  queueCollectionCount: number;
  onTranscribe(): void;
  onCancel(): void;
}

// Smart batch size increment/decrement logic
const getBatchSizeIncrement = (currentSize: number): number => {
  if (currentSize < 50) return 10;      // 10, 20, 30, 40
  if (currentSize < 100) return 25;     // 50, 75, 100
  if (currentSize < 200) return 50;     // 100, 150, 200
  return 100;                           // 200, 300, 400, 500
};

const getNextBatchSize = (currentSize: number): number => {
  const increment = getBatchSizeIncrement(currentSize);
  return Math.min(500, currentSize + increment);
};

const getPrevBatchSize = (currentSize: number): number => {
  const increment = getBatchSizeIncrement(currentSize - 1);
  return Math.max(10, currentSize - increment);
};

export default function ImageTranscriber({
  inputPath,
  outputDir,
  isTranscribing,
  mistralMode,
  recursive,
  batchEnabled,
  batchSize,
  inputIsDirectory,
  batchStats,
  onSelectInput,
  onSelectOutput,
  onClearInput,
  onClearOutput,
  onToggleRecursive,
  onToggleBatch,
  onBatchSizeChange,
  onOpenBatchQueue,
  queueCollectionCount,
  onTranscribe,
  onCancel
}: ImageTranscriberProps) {
  return (
    <>
      <div className="controls">
        <div className="field-row">
          <button onClick={onSelectInput}>
            <FaFileImage />
          </button>
          <div className="path-input-wrapper">
            <input
              readOnly
              value={inputPath}
              placeholder="Select image folder…"
            />
            <button
              type="button"
              onClick={onClearInput}
              aria-label="Clear image input path"
              disabled={!inputPath}
              title="Clear input path"
              className="clear-path-btn"
            >
              <FaTimesCircle />
            </button>
          </div>
        </div>
        <div className="field-row">
          <button onClick={onSelectOutput}>
            <FaFolderOpen />
          </button>
          <div className="path-input-wrapper">
            <input
              readOnly
              value={outputDir}
              placeholder="Select output folder…"
            />
            <button
              type="button"
              onClick={onClearOutput}
              aria-label="Clear image output folder"
              disabled={!outputDir}
              title="Clear output path"
              className="clear-path-btn"
            >
              <FaTimesCircle />
            </button>
          </div>
        </div>
      </div>

      {mistralMode && (
        <div className="options-row">
          <div className="action-buttons">
            {!isTranscribing ? (
              <button
                className="transcribe-btn"
                onClick={onTranscribe}
                disabled={!inputPath || !outputDir}
              >
                <FaMicrophone /> Transcribe
              </button>
            ) : (
              <button className="cancel-btn" onClick={onCancel}>
                <FaTimesCircle /> Cancel
              </button>
            )}
          </div>
          <div className="options-group">
            <label className="option-item" style={{ opacity: inputIsDirectory ? 1 : 0.6 }}>
              <input
                type="checkbox"
                checked={batchEnabled}
                onChange={onToggleBatch}
                disabled={!inputIsDirectory || isTranscribing}
              />
              Batch mode
            </label>
            {batchEnabled && (
              <div className="batch-controls-inline" style={{ opacity: inputIsDirectory ? 1 : 0.6 }}>
                <div className="batch-size-controls">
                  <span className="batch-size-label">Size</span>
                  <div className="batch-size-main">
                    <button
                      type="button"
                      className="batch-step-btn"
                      onClick={() => onBatchSizeChange(getPrevBatchSize(batchSize))}
                      disabled={batchSize <= 10 || !inputIsDirectory || isTranscribing}
                      aria-label="Decrease batch size"
                    >
                      −
                    </button>
                    <span className="batch-size-current">{batchSize}</span>
                    <button
                      type="button"
                      className="batch-step-btn"
                      onClick={() => onBatchSizeChange(getNextBatchSize(batchSize))}
                      disabled={batchSize >= 500 || !inputIsDirectory || isTranscribing}
                      aria-label="Increase batch size"
                    >
                      +
                    </button>
                  </div>
                </div>
                {inputIsDirectory && (
                  <div className="batch-mini-stats">
                    <div className="batch-mini-stat">
                      <span>Uploaded</span>
                      <strong>{batchStats?.uploaded ?? 0}</strong>
                    </div>
                    <div className="batch-mini-stat">
                      <span>Processing</span>
                      <strong>{batchStats?.processing ?? 0}</strong>
                    </div>
                    <div className="batch-mini-stat">
                      <span>Completed</span>
                      <strong>{batchStats?.completed ?? 0}</strong>
                    </div>
                    {(batchStats?.failed ?? 0) > 0 && (
                      <div className="batch-mini-stat failed">
                        <span>Failed</span>
                        <strong>{batchStats?.failed ?? 0}</strong>
                      </div>
                    )}
                  </div>
                )}
                {inputIsDirectory && (
                  <button
                    type="button"
                    className="batch-queue-open-btn"
                    onClick={onOpenBatchQueue}
                    disabled={isTranscribing}
                    aria-label="Open saved Mistral batch queue"
                  >
                    <FaListUl className="batch-queue-icon" aria-hidden="true" />
                    <span className="batch-queue-tooltip" role="tooltip">Open batch queue</span>
                    {queueCollectionCount > 0 && (
                      <span className="batch-queue-count-badge" aria-label={`${queueCollectionCount} saved collections`}>
                        {queueCollectionCount > 99 ? '99+' : queueCollectionCount}
                      </span>
                    )}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {!mistralMode && (
        <div className="action-buttons">
          {!isTranscribing ? (
            <button
              className="transcribe-btn"
              onClick={onTranscribe}
              disabled={!inputPath || !outputDir}
            >
              <FaMicrophone /> Transcribe
            </button>
          ) : (
            <button className="cancel-btn" onClick={onCancel}>
              <FaTimesCircle /> Cancel
            </button>
          )}
        </div>
      )}
    </>
  );
}
