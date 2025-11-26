// src/components/ImageTranscriber.tsx
import React from 'react';
import {
  FaFileImage,
  FaFolderOpen,
  FaMicrophone,
  FaTimesCircle,
  FaQuestionCircle
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
  onSelectInput(): void;
  onSelectOutput(): void;
  onToggleRecursive(): void;
  onToggleBatch(): void;
  onBatchSizeChange(size: number): void;
  onTranscribe(): void;
  onCancel(): void;
}

const InfoTooltip: React.FC<{ text: string }> = ({ text }) => {
  const [visible, setVisible] = React.useState(false);
  return (
    <div
      className="tooltip-wrapper"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <FaQuestionCircle size={14} />
      {visible && <div className="tooltip-box">{text}</div>}
    </div>
  );
};

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
  onSelectInput,
  onSelectOutput,
  onToggleRecursive,
  onToggleBatch,
  onBatchSizeChange,
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
          <input
            readOnly
            value={inputPath}
            placeholder="Select image folder…"
          />
        </div>
        <div className="field-row">
          <button onClick={onSelectOutput}>
            <FaFolderOpen />
          </button>
          <input
            readOnly
            value={outputDir}
            placeholder="Select output folder…"
          />
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
              <InfoTooltip text="Process in batches within a folder." />
            </label>
            {batchEnabled && (
              <div className="option-item batch-size-controls" style={{ opacity: inputIsDirectory ? 1 : 0.6 }}>
                <span style={{ marginRight: '0.75rem', fontWeight: 500 }}>Batch size:</span>
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '0.4rem',
                  background: 'rgba(255,255,255,0.05)',
                  padding: '0.3rem 0.5rem',
                  borderRadius: '6px',
                  border: '1px solid rgba(255,255,255,0.1)',
                  height: '2.2rem'
                }}>
                  <button
                    onClick={() => onBatchSizeChange(getPrevBatchSize(batchSize))}
                    disabled={batchSize <= 10 || !inputIsDirectory || isTranscribing}
                    style={{
                      background: batchSize <= 10 ? 'rgba(255,255,255,0.1)' : 'var(--accent)',
                      border: 'none',
                      color: batchSize <= 10 ? 'rgba(255,255,255,0.5)' : '#fff',
                      width: '1.6rem',
                      height: '1.6rem',
                      borderRadius: '4px',
                      cursor: batchSize <= 10 ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 600,
                      fontSize: '0.9rem',
                      transition: 'all 0.2s ease'
                    }}
                  >
                    −
                  </button>
                  <span style={{ 
                    minWidth: '3.5rem', 
                    textAlign: 'center', 
                    display: 'inline-block',
                    fontWeight: 600,
                    fontSize: '0.9rem',
                    color: 'var(--text-light)'
                  }}>
                    {batchSize}
                  </span>
                  <button
                    onClick={() => onBatchSizeChange(getNextBatchSize(batchSize))}
                    disabled={batchSize >= 500 || !inputIsDirectory || isTranscribing}
                    style={{
                      background: batchSize >= 500 ? 'rgba(255,255,255,0.1)' : 'var(--accent)',
                      border: 'none',
                      color: batchSize >= 500 ? 'rgba(255,255,255,0.5)' : '#fff',
                      width: '1.6rem',
                      height: '1.6rem',
                      borderRadius: '4px',
                      cursor: batchSize >= 500 ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 600,
                      fontSize: '0.9rem',
                      transition: 'all 0.2s ease'
                    }}
                  >
                    +
                  </button>
                </div>
                <InfoTooltip text="Processes a folder in batches (non-recursive). Adjust size to balance throughput vs. request size." />
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
