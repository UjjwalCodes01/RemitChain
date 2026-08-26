/**
 * lib/http.ts
 *
 * Small shared helpers for route handlers.
 */

import type { NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'

// ─── Structured logging ──────────────────────────────────────────────────────

/**
 * One-line JSON logs, picked up by the Vercel log drain.
 *
 * Never pass a full transfer id, phone number, payout destination, OTP or claim
 * secret. Callers truncate or mask before logging.
 */
export function log(
  level: 'info' | 'warn' | 'error',
  step: string,
  meta: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ level, step, ts: new Date().toISOString(), ...meta }))
}

// ─── Request helpers ─────────────────────────────────────────────────────────

export function clientIp(req: NextRequest): string {
  // Vercel sets x-forwarded-for; the left-most entry is the client.
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return req.headers.get('x-real-ip')?.trim() ?? 'unknown'
}

/** Short prefix of a transfer id, safe for logs. */
export function shortId(id: string): string {
  return `${id.slice(0, 10)}…`
}

// ─── Cron authentication ─────────────────────────────────────────────────────

export type CronAuthResult = { ok: true } | { ok: false; reason: string }

/**
 * Authenticate a scheduled-job request.
 *
 * The previous implementation accepted a request as "same origin" when the
 * Origin header was the empty string:
 *
 *     const isSameOrigin = appUrl && (origin.includes(host) || origin === appUrl || origin === '')
 *
 * A plain `curl` sends no Origin header at all, so `origin === ''` was true and
 * CRON_SECRET was never actually enforced — the endpoints were open to anyone.
 *
 * There is no origin-based bypass here. A caller either presents the shared
 * secret or is rejected. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
 * automatically.
 */
export function authenticateCron(req: NextRequest): CronAuthResult {
  const secret = process.env.CRON_SECRET

  if (!secret) {
    // Without a secret there is nothing to verify. Allowed off-production only;
    // lib/env.server.ts makes CRON_SECRET mandatory on a production chain, so
    // this branch cannot be reached there.
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, reason: 'CRON_SECRET is not configured' }
    }
    return { ok: true }
  }

  const header = req.headers.get('authorization') ?? ''
  const expected = `Bearer ${secret}`

  const a = Buffer.from(header, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'Invalid or missing cron credentials' }
  }

  return { ok: true }
}
