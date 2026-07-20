interface StepperProps {
  value: number;
  onDecrement(): void;
  onIncrement(): void;
  decrementDisabled?: boolean;
  incrementDisabled?: boolean;
  label: string; // e.g. "batch size", "preprocess workers"
  liveValue?: boolean; // set aria-live=polite on the value (Settings does this)
}

/**
 * Shared - / value / + stepper. Reuses the existing .batch-size-main,
 * .batch-step-btn and .batch-size-current styles so it stays on-theme.
 */
export default function Stepper({
  value,
  onDecrement,
  onIncrement,
  decrementDisabled,
  incrementDisabled,
  label,
  liveValue
}: StepperProps) {
  return (
    <div className="batch-size-main">
      <button
        type="button"
        className="batch-step-btn"
        onClick={onDecrement}
        disabled={decrementDisabled}
        aria-label={`Decrease ${label}`}
      >
        −
      </button>
      <span className="batch-size-current" {...(liveValue ? { 'aria-live': 'polite' as const } : {})}>
        {value}
      </span>
      <button
        type="button"
        className="batch-step-btn"
        onClick={onIncrement}
        disabled={incrementDisabled}
        aria-label={`Increase ${label}`}
      >
        +
      </button>
    </div>
  );
}
