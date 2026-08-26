/**
 * lib/otp-guard.ts
 *
 * Durable brute-force protection for the claim OTP.
 *
 * The OTP is a 6-digit second factor. The high-entropy claim secret is what
 * actually protects the on-chain commitment (see lib/claim-secret.ts), but an
 * attacker holding a forwarded claim link still only faces a million codes —
 * so the online guess rate has to be tightly bounded.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED
 * ─────────────────────────────────────────────────────────────────────────────
 * The lock used to be permanent: `locked_at != null` meant locked forever, with
 * no expiry and no release path. One mistyped code from a recipient — the
 * person least equipped to deal with it — stranded their money behind a
 * "Contact support" message with no support to contact. The in-memory fallback
 * meanwhile expired after 10 minutes, so the two paths disagreed about what the
 * rule even was.
 *
 * Locks are now time-boxed and escalate: 15m, 1h, 6h, then 24h. That keeps the
 * online guess rate to a handful per hour while always giving the legitimate
 * recipient a way back in.
 */

import { eq } from 'drizzle-orm'
import { db, otpAttempts } from '@/lib/db'
import { log } from '@/lib/http'

/** Failures allowed before a lock is applied. */
export const MAX_OTP_ATTEMPTS = 5

/** Lock duration by how many times this transfer has already been locked. */
const LOCKOUT_LADDER_MS = [
  15 * 60 * 1000,       // 1st: 15 minutes
  60 * 60 * 1000,       // 2nd: 1 hour
  6 * 60 * 60 * 1000,   // 3rd: 6 hours
  24 * 60 * 60 * 1000,  // 4th and beyond: 24 hours
]

function lockoutFor(lockoutCount: number): number {
  return LOCKOUT_LADDER_MS[Math.min(lockoutCount, LOCKOUT_LADDER_MS.length - 1)]
}

// ─── In-process fallback (dev only; production requires a database) ──────────

interface LocalAttempt {
  attemptCount: number
  lockedUntil: number
  lockoutCount: number
}

const MAX_LOCAL_ENTRIES = 5_000
const localAttempts = new Map<string, LocalAttempt>()

function pruneLocal(now: number) {
  for (const [key, rec] of localAttempts) {
    if (rec.lockedUntil !== 0 && rec.lockedUntil <= now && rec.attemptCount === 0) {
      localAttempts.delete(key)
    }
  }
  if (localAttempts.size > MAX_LOCAL_ENTRIES) {
    const excess = localAttempts.size - MAX_LOCAL_ENTRIES
    let dropped = 0
    for (const key of localAttempts.keys()) {
      localAttempts.delete(key)
      if (++dropped >= excess) break
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface LockState {
  locked: boolean
  retryAfterMs: number
}

export async function checkOtpLock(transferId: string): Promise<LockState> {
  const now = Date.now()

  if (!db) {
    pruneLocal(now)
    const rec = localAttempts.get(transferId)
    if (!rec || rec.lockedUntil <= now) return { locked: false, retryAfterMs: 0 }
    return { locked: true, retryAfterMs: rec.lockedUntil - now }
  }

  const rows = await db.select().from(otpAttempts).where(eq(otpAttempts.transferId, transferId)).limit(1)
  const row = rows[0]

  if (!row?.lockedUntil || row.lockedUntil <= now) return { locked: false, retryAfterMs: 0 }
  return { locked: true, retryAfterMs: row.lockedUntil - now }
}

export interface FailureResult {
  attemptCount: number
  attemptsRemaining: number
  locked: boolean
  retryAfterMs: number
}

/** Record one failed credential check, locking the transfer if needed. */
export async function recordOtpFailure(transferId: string, ip: string): Promise<FailureResult> {
  const now = Date.now()

  if (!db) {
    pruneLocal(now)
    const rec = localAttempts.get(transferId) ?? { attemptCount: 0, lockedUntil: 0, lockoutCount: 0 }
    rec.attemptCount++
    if (rec.attemptCount >= MAX_OTP_ATTEMPTS) {
      rec.lockedUntil = now + lockoutFor(rec.lockoutCount)
      rec.lockoutCount++
      rec.attemptCount = 0
    }
    localAttempts.set(transferId, rec)
    return {
      attemptCount: rec.attemptCount,
      attemptsRemaining: Math.max(0, MAX_OTP_ATTEMPTS - rec.attemptCount),
      locked: rec.lockedUntil > now,
      retryAfterMs: Math.max(0, rec.lockedUntil - now),
    }
  }

  const rows = await db.select().from(otpAttempts).where(eq(otpAttempts.transferId, transferId)).limit(1)
  const existing = rows[0]

  const attemptCount = (existing?.attemptCount ?? 0) + 1
  const lockoutCount = existing?.lockoutCount ?? 0

  const shouldLock = attemptCount >= MAX_OTP_ATTEMPTS
  const lockedUntil = shouldLock ? now + lockoutFor(lockoutCount) : (existing?.lockedUntil ?? null)

  try {
    await db
      .insert(otpAttempts)
      .values({
        transferId,
        // Counting restarts after a lock, so the ladder governs the rate rather
        // than the counter growing without bound.
        attemptCount: shouldLock ? 0 : attemptCount,
        lockedUntil,
        lockoutCount: shouldLock ? lockoutCount + 1 : lockoutCount,
        lastAttemptAt: now,
        lastAttemptIp: ip,
      })
      .onConflictDoUpdate({
        target: otpAttempts.transferId,
        set: {
          attemptCount: shouldLock ? 0 : attemptCount,
          lockedUntil,
          lockoutCount: shouldLock ? lockoutCount + 1 : lockoutCount,
          lastAttemptAt: now,
          lastAttemptIp: ip,
        },
      })
  } catch (err) {
    // The attempts table has a foreign key to transfers. A claim against a
    // transfer with no local row (sent before this deployment) would violate
    // it — the IP rate limit still applies, so fail soft rather than blocking
    // a legitimate recipient.
    log('warn', 'otp_guard.record_failed', { err: String(err).slice(0, 200) })
  }

  if (shouldLock) {
    log('warn', 'otp_guard.locked', {
      transferId: `${transferId.slice(0, 10)}…`,
      lockoutNumber: lockoutCount + 1,
      durationMs: lockoutFor(lockoutCount),
    })
  }

  return {
    attemptCount: shouldLock ? 0 : attemptCount,
    attemptsRemaining: shouldLock ? 0 : Math.max(0, MAX_OTP_ATTEMPTS - attemptCount),
    locked: shouldLock,
    retryAfterMs: shouldLock ? lockoutFor(lockoutCount) : 0,
  }
}

/** Clear the counter after a successful claim. */
export async function clearOtpAttempts(transferId: string): Promise<void> {
  localAttempts.delete(transferId)
  if (!db) return
  try {
    await db.delete(otpAttempts).where(eq(otpAttempts.transferId, transferId))
  } catch (err) {
    log('warn', 'otp_guard.clear_failed', { err: String(err).slice(0, 160) })
  }
}
