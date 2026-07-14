export function createRateLimiter({ clock = Date.now } = {}) {
  const buckets = new Map();

  function consume(key, { limit, windowMs }) {
    const safeKey = String(key || '').trim();
    if (!safeKey) return { allowed: false, retryAfterMs: windowMs };
    const now = clock();
    const cutoff = now - windowMs;
    const recent = (buckets.get(safeKey) || []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= limit) {
      buckets.set(safeKey, recent);
      return { allowed: false, retryAfterMs: Math.max(1, recent[0] + windowMs - now) };
    }
    recent.push(now);
    buckets.set(safeKey, recent);
    return { allowed: true, retryAfterMs: 0 };
  }

  return { consume };
}

export default createRateLimiter;
