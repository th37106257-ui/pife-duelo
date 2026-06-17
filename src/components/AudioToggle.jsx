import { useEffect, useState } from 'react';
import {
  initSoundSystem,
  isAudioEnabled,
  playSoundEffect,
  setAudioEnabled,
  subscribeAudioPreference,
} from '../services/soundEffects.js';

export default function AudioToggle() {
  const [enabled, setEnabled] = useState(() => isAudioEnabled());

  useEffect(() => {
    initSoundSystem();
    return subscribeAudioPreference(setEnabled);
  }, []);

  const toggleAudio = () => {
    const nextEnabled = !enabled;
    setAudioEnabled(nextEnabled);
    setEnabled(nextEnabled);
    if (nextEnabled) {
      window.setTimeout(() => playSoundEffect('turn'), 0);
    }
  };

  return (
    <button
      type="button"
      className={`chrome-button audio-toggle-button ${enabled ? 'is-on' : 'is-off'}`}
      aria-label={enabled ? 'Desligar sons' : 'Ligar sons'}
      title={enabled ? 'Desligar sons' : 'Ligar sons'}
      onClick={toggleAudio}
    >
      S
    </button>
  );
}
