/**
 * lib/db/redis.ts
 *
 * Upstash Redis client singleton.
 * Gracefully degrades to null when UPSTASH_REDIS_REST_URL is absent.
 */

import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'

// ── Redis singleton ──────────────────────────────────────────────────────────

let _redis: Redis | null = null

export function getRedis(): Redis | null {
  if (_redis) return _redis

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!url || !token) {
    // Don't spam — log once at module init
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[Redis] UPSTASH_REDIS_REST_URL not set — Redis features disabled')
    }
    return null
  }

  _redis = new Redis({ url, token })
  return _redis
}

// ── Rate-limiters ────────────────────────────────────────────────────────────

// 3 requests per IP per 60 minutes for claim endpoint
let _ipRatelimit: Ratelimit | null = null

export function getIpRatelimit(): Ratelimit | null {
  if (_ipRatelimit) return _ipRatelimit
  const redis = getRedis()
  if (!redis) return null

  _ipRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(3, '60 m'),
    prefix: 'rl:claim:ip',
  })
  return _ipRatelimit
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

/** Set a JSON value in Redis with TTL in seconds. No-op if Redis unavailable. */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const redis = getRedis()
  if (!redis) return
  try {
    await redis.set(key, JSON.stringify(value), { ex: ttlSeconds })
  } catch (err) {
    console.warn('[Redis] cacheSet failed:', err)
  }
}

/** Get a cached JSON value. Returns null if absent or Redis unavailable. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = getRedis()
  if (!redis) return null
  try {
    const raw = await redis.get<string>(key)
    if (!raw) return null
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T
  } catch (err) {
    console.warn('[Redis] cacheGet failed:', err)
    return null
  }
}
