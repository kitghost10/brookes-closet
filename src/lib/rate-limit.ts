/**
 * Fixed-window in-memory rate limiter.
 * LIMITATION: per-process. Behind multiple instances/serverless, replace with a shared store
 * (Redis/Upstash) by re-implementing `rateLimit` with the same signature.
 */
type Bucket = { count: number; resetAt: number };
const g = globalThis as unknown as { __bcRl?: Map<string, Bucket> };
const buckets = (g.__bcRl ??= new Map<string, Bucket>());

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): { ok: boolean; retryAfterSec: number } {
  if (buckets.size > 10_000) for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  b.count++;
  return b.count <= limit ? { ok: true, retryAfterSec: 0 } : { ok: false, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
}

export function resetRateLimits() { buckets.clear(); }
