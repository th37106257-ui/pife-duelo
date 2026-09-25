const HAPTICS_ENABLED_KEY = 'pifeDuelo.hapticsEnabled';

export function isHapticsEnabled() {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(HAPTICS_ENABLED_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setHapticsEnabled(enabled) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HAPTICS_ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    // Storage may be unavailable in private browsing; the game still works.
  }
}

export function vibrateForGame(pattern) {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function' || !isHapticsEnabled()) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Haptics are optional and must never interrupt an action.
  }
}
