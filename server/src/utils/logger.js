import { recordServerLog } from '../observabilityStore.js';

function log(level, event, data = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    ...data,
  };

  const storedLevel = level === 'log' ? 'info' : level;
  recordServerLog({
    level: storedLevel,
    event,
    message: data.message ?? event,
    stack: data.stack,
    ...data,
  });

  console[level](`[PIFE_SERVER][${event}]`, payload);
}

export function logInfo(event, data) {
  log('log', event, data);
}

export function logWarn(event, data) {
  log('warn', event, data);
}

export function logError(event, data) {
  log('error', event, data);
}
