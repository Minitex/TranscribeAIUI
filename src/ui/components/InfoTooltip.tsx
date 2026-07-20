import React, { useState } from 'react';
import { FaQuestionCircle } from 'react-icons/fa';

/**
 * Single, accessible tooltip used across the app. CSS-driven via the existing
 * .tooltip-wrapper / .tooltip-box classes in App.css plus a .tooltip-trigger
 * rule, so it stays on-theme automatically. Shows on hover AND keyboard focus,
 * dismisses on Escape, and ties the trigger to the tip via aria-describedby.
 */
const InfoTooltip: React.FC<{ text: string }> = ({ text }) => {
  const [visible, setVisible] = useState(false);
  const tipId = React.useId();
  const show = () => setVisible(true);
  const hide = () => setVisible(false);
  return (
    <span className="tooltip-wrapper" style={{ marginLeft: 6 }}>
      <button
        type="button"
        className="tooltip-trigger"
        aria-label="More info"
        aria-describedby={visible ? tipId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={e => {
          if (e.key === 'Escape') hide();
        }}
      >
        <FaQuestionCircle size={14} />
      </button>
      {visible && (
        <span id={tipId} role="tooltip" className="tooltip-box">
          {text}
        </span>
      )}
    </span>
  );
};

export default InfoTooltip;
