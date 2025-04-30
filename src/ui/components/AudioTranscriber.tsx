// src/components/AudioTranscriber.tsx
import React from 'react';
import {
  FaFileAudio,
  FaFolderOpen,
  FaMicrophone,
  FaTimesCircle
} from 'react-icons/fa';

export type Transcript = { name: string; path: string };

interface AudioTranscriberProps {
  inputPath: string;
  outputDir: string;
  isTranscribing: boolean;
  onSelectInput(): void;
  onSelectOutput(): void;
  onTranscribe(): void;
  onCancel(): void;
}

export default function AudioTranscriber({
  inputPath,
  outputDir,
  isTranscribing,
  onSelectInput,
  onSelectOutput,
  onTranscribe,
  onCancel
}: AudioTranscriberProps) {
  return (
    <>
      <div className="controls">
        <div className="field-row">
          <button onClick={onSelectInput}>
            <FaFileAudio />
          </button>
          <input
            readOnly
            value={inputPath}
            placeholder="Select audio file…"
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
    </>
  );
}