import { motion } from 'framer-motion';
import { memo } from 'react';

function Timer({ seconds, maxSeconds = 60, variant = 'default', label = 'Sua vez' }) {
  const progress = Math.max(0, Math.min(1, seconds / maxSeconds));
  const circumference = 2 * Math.PI * 22;
  const urgencyClass =
    seconds <= 3 ? 'timer-critical' : seconds <= 5 ? 'timer-low' : seconds <= 10 ? 'timer-warning' : '';
  const transitionDuration = seconds <= 3 ? 0.16 : seconds <= 10 ? 0.24 : 0.38;

  return (
    <div
      className={`timer-ring ${variant === 'mini' ? 'timer-ring-mini' : ''} ${variant === 'table' ? 'timer-ring-table' : ''} ${urgencyClass}`}
      aria-label={`${seconds} segundos restantes`}
    >
      <svg viewBox="0 0 56 56" aria-hidden="true">
        <circle className="timer-track" cx="28" cy="28" r="22" />
        <motion.circle
          className={`timer-progress ${seconds <= 5 ? 'timer-danger' : seconds <= 10 ? 'timer-caution' : ''}`}
          cx="28"
          cy="28"
          r="22"
          animate={{ strokeDashoffset: circumference * (1 - progress) }}
          strokeDasharray={circumference}
          transition={{ duration: transitionDuration, ease: 'easeOut' }}
        />
      </svg>
      <span className="timer-copy">
        <strong>{seconds}</strong>
        {variant === 'table' ? <em>segundos</em> : null}
      </span>
    </div>
  );
}

export default memo(Timer);
