/** Token bucket with bounded, idle-expiring keys for process-wide limits. */
export class RateLimiter {
  constructor({now = Date.now, idleTtlMs = 10 * 60 * 1000, maxKeys = 10000} = {}) {
    this.now = now;
    this.idleTtlMs = idleTtlMs;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
    this.callsSinceCleanup = 0;
  }

  consume(key, {capacity, refillPerSecond}, cost = 1) {
    const now = this.now();
    if (++this.callsSinceCleanup >= 128 || this.buckets.size >= this.maxKeys) this._cleanup(now);
    let bucket = this.buckets.get(key);
    if (!bucket) bucket = {tokens: capacity, updatedAt: now};
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.buckets.set(key, bucket);
      return {allowed: true, retryAfterMs: 0};
    }
    this.buckets.set(key, bucket);
    return {allowed: false, retryAfterMs: Math.max(1, Math.ceil(((cost - bucket.tokens) / refillPerSecond) * 1000))};
  }

  delete(key) { this.buckets.delete(key); }

  _cleanup(now) {
    this.callsSinceCleanup = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > this.idleTtlMs) this.buckets.delete(key);
    }
    while (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
  }
}

export const consumeEventLimit = (limiter, key, policy) => limiter.consume(key, policy);
