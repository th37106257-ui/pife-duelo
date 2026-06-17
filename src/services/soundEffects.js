const AUDIO_ENABLED_KEY = 'pifeDuelo.audioEnabled';
const MASTER_VOLUME = 0.16;
const SAMPLE_RATE = 44100;
const buffers = new Map();
const subscribers = new Set();
const lastPlayedAt = new Map();

let audioContext = null;
let masterGain = null;
let unlocked = false;
let unlockListenersAttached = false;

function readStoredAudioPreference() {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(AUDIO_ENABLED_KEY) === '1';
}

function writeStoredAudioPreference(enabled) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(AUDIO_ENABLED_KEY, enabled ? '1' : '0');
}

function createBuffer(context, duration, renderSample) {
  const length = Math.max(1, Math.floor(duration * SAMPLE_RATE));
  const buffer = context.createBuffer(1, length, SAMPLE_RATE);
  const data = buffer.getChannelData(0);

  for (let index = 0; index < length; index += 1) {
    const time = index / SAMPLE_RATE;
    const progress = time / duration;
    const attack = Math.min(1, progress / 0.08);
    const release = Math.max(0, 1 - progress);
    const envelope = Math.min(attack, release);
    data[index] = renderSample(time, progress) * envelope;
  }

  return buffer;
}

function tone(frequency, time, type = 'sine') {
  const phase = Math.PI * 2 * frequency * time;
  if (type === 'triangle') return (2 / Math.PI) * Math.asin(Math.sin(phase));
  if (type === 'square') return Math.sign(Math.sin(phase));
  return Math.sin(phase);
}

function preloadBuffers(context) {
  if (buffers.size > 0) return;

  buffers.set('draw', createBuffer(context, 0.14, (time, progress) => {
    const frequency = 520 + progress * 220;
    return tone(frequency, time, 'triangle') * 0.58;
  }));
  buffers.set('discard', createBuffer(context, 0.16, (time, progress) => {
    const frequency = 360 - progress * 80;
    return tone(frequency, time, 'triangle') * 0.5;
  }));
  buffers.set('turn', createBuffer(context, 0.18, (time, progress) => {
    const first = tone(620, time, 'sine');
    const second = progress > 0.44 ? tone(830, time, 'sine') : 0;
    return (first * 0.42 + second * 0.36);
  }));
  buffers.set('alert', createBuffer(context, 0.09, (time) => tone(980, time, 'triangle') * 0.42));
  buffers.set('beat', createBuffer(context, 0.2, (time) => {
    return (tone(440, time, 'triangle') + tone(660, time, 'triangle')) * 0.28;
  }));
  buffers.set('win', createBuffer(context, 0.42, (time, progress) => {
    const sequence = progress < 0.34 ? 523 : progress < 0.67 ? 659 : 784;
    return tone(sequence, time, 'sine') * 0.44;
  }));
  buffers.set('loss', createBuffer(context, 0.36, (time, progress) => {
    const frequency = progress < 0.5 ? 360 : 270;
    return tone(frequency, time, 'triangle') * 0.34;
  }));
}

function ensureAudioContext() {
  if (typeof window === 'undefined') return null;
  if (audioContext) return audioContext;

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  audioContext = new AudioContextClass({ sampleRate: SAMPLE_RATE });
  masterGain = audioContext.createGain();
  masterGain.gain.value = MASTER_VOLUME;
  masterGain.connect(audioContext.destination);
  preloadBuffers(audioContext);

  return audioContext;
}

export function unlockAudio() {
  const context = ensureAudioContext();
  if (!context) return;

  if (context.state === 'suspended') {
    context.resume().catch(() => {});
  }
  unlocked = true;
}

export function initSoundSystem() {
  if (unlockListenersAttached || typeof window === 'undefined') return;
  unlockListenersAttached = true;

  const handleFirstGesture = () => {
    unlockAudio();
    window.removeEventListener('pointerdown', handleFirstGesture, true);
    window.removeEventListener('touchstart', handleFirstGesture, true);
    window.removeEventListener('keydown', handleFirstGesture, true);
  };

  window.addEventListener('pointerdown', handleFirstGesture, true);
  window.addEventListener('touchstart', handleFirstGesture, true);
  window.addEventListener('keydown', handleFirstGesture, true);
}

export function isAudioEnabled() {
  return readStoredAudioPreference();
}

export function setAudioEnabled(enabled) {
  writeStoredAudioPreference(Boolean(enabled));
  if (enabled) unlockAudio();
  subscribers.forEach((listener) => listener(Boolean(enabled)));
}

export function subscribeAudioPreference(listener) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function playSoundEffect(name) {
  if (!readStoredAudioPreference()) return;

  const now = Date.now();
  const lastTime = lastPlayedAt.get(name) ?? 0;
  const cooldown = name === 'alert' ? 850 : 70;
  if (now - lastTime < cooldown) return;
  lastPlayedAt.set(name, now);

  const context = ensureAudioContext();
  if (!context || !masterGain) return;
  if (!unlocked && context.state === 'suspended') return;

  const buffer = buffers.get(name);
  if (!buffer) return;

  const source = context.createBufferSource();
  const gain = context.createGain();
  gain.gain.value = name === 'alert' ? 0.68 : 0.82;
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(masterGain);
  source.start();
}
