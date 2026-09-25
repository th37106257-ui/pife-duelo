import { useState } from 'react';
import { isHapticsEnabled, setHapticsEnabled, vibrateForGame } from '../services/haptics.js';

export default function HapticsToggle() {
  const [enabled, setEnabled] = useState(isHapticsEnabled);

  const toggle = () => {
    const next = !enabled;
    setHapticsEnabled(next);
    setEnabled(next);
    if (next) vibrateForGame(12);
  };

  return (
    <button
      type="button"
      className={`chrome-button haptics-toggle-button ${enabled ? 'is-on' : 'is-off'}`}
      aria-label={enabled ? 'Desligar vibração' : 'Ligar vibração'}
      title={enabled ? 'Desligar vibração' : 'Ligar vibração'}
      aria-pressed={enabled}
      onClick={toggle}
    >
      <span aria-hidden="true">◉</span>
    </button>
  );
}
