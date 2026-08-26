/**
 * lib/ratelimit.ts
 *
 * Distributed rate limiting, with a bounded in-process fallback.
 *
 * The previous code created one `Ratelimit` for the claim endpoint and used
 * ad-hoc `Map`s everywhere else. Those maps were unbounded — every distinct
 * transfer id or address added an entry that was never evicted, so a long-lived
 * instance leaked memory — and, being per-instance, they enforced nothing at
 * all across a fleet of serverless workers.
 */

import { Ratelimit } from '@upstash/ratelimit'
import { getRedis } from '@/lib/db/redis'

export interface RateLimitOptions {
  limit: number
  windowSeconds: number
}

export interface RateLimitResult {
  success: boolean
  remaining: number
  retryAfterSeconds: number
}

// ─── Upstash limiters, memoised per (namespace, limit, window) ───────────────

const limiters = new Map<string, Ratelimit>()

function getLimiter(namespace: string, opts: RateLimitOptions): Ratelimit | null {
  const redis = getRedis()
  if (!redis) return null

  const key = `${namespace}:${opts.limit}:${opts.windowSeconds}`
  const existing = limiters.get(key)
  if (existing) return existing

  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(opts.limit, `${opts.windowSeconds} s`),
    prefix: `rl:${namespace}`,
    analytics: false,
  })
  limiters.set(key, limiter)
  return limiter
}

// ─── Bounded in-process fallback ─────────────────────────────────────────────

interface Bucket {
  count: number
  resetAt: number
}

/** Hard cap so the fallback cannot grow without bound. */
const MAX_LOCAL_BUCKETS = 10_000
const localBuckets = new Map<string, Bucket>()

function pruneLocal(now: number): void {
  for (const [key, bucket] of localBuckets) {
    if (bucket.resetAt <= now) localBuckets.delete(key)
  }
  // Still oversized after pruning expired entries: drop oldest-first.
  if (localBuckets.size > MAX_LOCAL_BUCKETS) {
    const excess = localBuckets.size - MAX_LOCAL_BUCKETS
    let dropped = 0
    for (const key of localBuckets.keys()) {
      localBuckets.delete(key)
      if (++dropped >= excess) break
    }
  }
}

function localLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now()
  if (localBuckets.size > MAX_LOCAL_BUCKETS / 2) pruneLocal(now)

  const bucket = localBuckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    localBuckets.set(key, { count: 1, resetAt: now + opts.windowSeconds * 1000 })
    return { success: true, remaining: opts.limit - 1, retryAfterSeconds: 0 }
  }

  bucket.count++
  if (bucket.count > opts.limit) {
    return {
      success: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    }
  }

  return { success: true, remaining: opts.limit - bucket.count, retryAfterSeconds: 0 }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Consume one unit from `namespace:identifier`.
 *
 * Uses Redis when available so the limit holds across the whole fleet, and
 * falls back to a per-instance bucket otherwise. The fallback is weaker by
 * definition — which is exactly why `UPSTASH_REDIS_REST_URL` is required on a
 * production chain.
 */
export async function rateLimit(
  namespace: string,
  identifier: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const limiter = getLimiter(namespace, opts)

  if (limiter) {
    try {
      const res = await limiter.limit(identifier)
      return {
        success: res.success,
        remaining: res.remaining,
        retryAfterSeconds: res.success
          ? 0
          : Math.max(1, Math.ceil((res.reset - Date.now()) / 1000)),
      }
    } catch (err) {
      // Redis being down must not take the whole product down; degrade to the
      // local bucket rather than failing the request open.
      console.warn('[ratelimit] Redis limiter failed, using local fallback:', String(err).slice(0, 160))
    }
  }

  return localLimit(`${namespace}:${identifier}`, opts)
}
