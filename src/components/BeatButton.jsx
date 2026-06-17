import { motion } from 'framer-motion';

export default function BeatButton({ canBeat, onBeat, isAnimating = false }) {
  const isReady = canBeat && !isAnimating;

  return (
    <motion.button
      type="button"
      disabled={!isReady}
      onClick={onBeat}
      aria-label="Bater"
      className={`beat-button ${isReady ? 'active' : 'disabled'} ${isAnimating ? 'hit-confirmed' : ''}`}
      whileTap={isReady ? { scale: 0.94, y: 2 } : undefined}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
    >
      <span className="beat-button__icon" aria-hidden="true">
        <i />
        <i />
      </span>
      <span className="beat-button__label">BATER</span>
    </motion.button>
  );
}
