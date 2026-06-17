const adminLogs = [];

export function recordAdminLog({ adminAction, targetId = null, reason = null, result = 'ok' } = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    adminAction: adminAction ?? 'unknown',
    targetId,
    reason,
    result,
  };
  adminLogs.push(entry);
  if (adminLogs.length > 500) adminLogs.shift();
  return entry;
}

export function listAdminLogs({ limit = 100 } = {}) {
  return [...adminLogs].reverse().slice(0, limit);
}

export function clearAdminLogs() {
  adminLogs.length = 0;
}

export default {
  recordAdminLog,
  listAdminLogs,
  clearAdminLogs,
};
