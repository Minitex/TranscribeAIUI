// src/components/ImageTranscriber.tsx
import React from 'react';
import {
  FaFileImage,
  FaFolderOpen,
  FaMicrophone,
  FaTimesCircle
} from 'react-icons/fa';
import { Transcript } from './AudioTranscriber';

interface ImageTranscriberProps {
  inputPath: string;
  outputDir: string;
  isTranscribing: boolean;
  onSelectInput(): void;
  onSelectOutput(): void;
  onTranscribe(): void;
  onCancel(): void;
}

export default function ImageTranscriber({
  inputPath,
  outputDir,
  isTranscribing,
  onSelectInput,
  onSelectOutput,
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
            placeholder="Select image or folder…"
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