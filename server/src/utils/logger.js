function log(level, event, data = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    ...data,
  };

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
