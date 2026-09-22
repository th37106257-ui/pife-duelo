export function createRateLimiter({ clock = Date.now, maxBuckets = 5000 } = {}) {
  const buckets = new Map();
  const safeMaxBuckets = Math.max(1, Math.floor(Number(maxBuckets) || 5000));
  let operations = 0;

  function pruneExpired(now) {
    for (const [key, bucket] of buckets) {
      if (bucket.expiresAt <= now) buckets.delete(key);
    }
  }

  function consume(key, { limit, windowMs }) {
    const safeKey = String(key || '').trim();
    const safeWindowMs = Math.max(1, Number(windowMs) || 1);
    const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
    if (!safeKey) return { allowed: false, retryAfterMs: safeWindowMs };

    const now = clock();
    operations += 1;
    if (operations % 64 === 0) pruneExpired(now);

    const cutoff = now - safeWindowMs;
    const bucket = buckets.get(safeKey);
    const recent = (bucket?.timestamps ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= safeLimit) {
      buckets.delete(safeKey);
      buckets.set(safeKey, { timestamps: recent, expiresAt: now + safeWindowMs });
      return { allowed: false, retryAfterMs: Math.max(1, recent[0] + safeWindowMs - now) };
    }

    recent.push(now);
    if (bucket) buckets.delete(safeKey);
    else if (buckets.size >= safeMaxBuckets) {
      pruneExpired(now);
      while (buckets.size >= safeMaxBuckets) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey === undefined) break;
        buckets.delete(oldestKey);
      }
    }
    buckets.set(safeKey, { timestamps: recent, expiresAt: now + safeWindowMs });
    return { allowed: true, retryAfterMs: 0 };
  }

  return { consume };
}

export default createRateLimiter;
