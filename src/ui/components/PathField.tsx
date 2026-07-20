import React from 'react';
import { FaTimesCircle } from 'react-icons/fa';

interface PathFieldProps {
  icon: React.ReactNode; // e.g. <FaFileImage /> or <FaFolderOpen />
  value: string;
  placeholder: string;
  onSelect(): void;
  onClear(): void;
  selectAriaLabel: string;
  inputAriaLabel: string;
  clearTitle?: string;
  clearAriaLabel: string;
}

/**
 * Shared "icon button + read-only path input + clear button" row used for both
 * input and output paths in the Audio and Image transcribers.
 */
export default function PathField({
  icon,
  value,
  placeholder,
  onSelect,
  onClear,
  selectAriaLabel,
  inputAriaLabel,
  clearTitle = 'Clear path',
  clearAriaLabel
}: PathFieldProps) {
  return (
    <div className="field-row">
      <button type="button" onClick={onSelect} aria-label={selectAriaLabel}>
        {icon}
      </button>
      <div className="path-input-wrapper">
        <input readOnly value={value} placeholder={placeholder} aria-label={inputAriaLabel} />
        <button
          type="button"
          onClick={onClear}
          aria-label={clearAriaLabel}
          disabled={!value}
          title={clearTitle}
          className="clear-path-btn"
        >
          <FaTimesCircle />
        </button>
      </div>
    </div>
  );
}
