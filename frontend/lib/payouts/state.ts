/**
 * lib/payouts/state.ts
 *
 * The payout state machine, in one place.
 *
 * Every status change goes through `assertTransition`. Illegal transitions
 * throw rather than silently corrupting the ledger — in particular, nothing
 * may move OUT of a terminal state, so a late-arriving webhook can never flip
 * a PAID payout back to PROCESSING and cause a re-send.
 */

import type { PayoutStatus } from './types'

const TRANSITIONS: Record<PayoutStatus, readonly PayoutStatus[]> = {
  // Freshly written to the ledger. Nothing has been requested yet.
  CREATED: ['SUBMITTED', 'FAILED', 'MANUAL_REVIEW'],

  // Handed to the provider. They may accept (PROCESSING), settle immediately
  // (PAID — some rails are instant), or reject (FAILED).
  SUBMITTED: ['PROCESSING', 'PAID', 'FAILED', 'MANUAL_REVIEW', 'REVERSED'],

  // Provider is moving the money.
  PROCESSING: ['PAID', 'FAILED', 'REVERSED', 'MANUAL_REVIEW'],

  // Retryable failure. The worker re-submits with the SAME idempotency key.
  FAILED: ['SUBMITTED', 'MANUAL_REVIEW'],

  // Terminal.
  PAID: [],
  REVERSED: [],
  MANUAL_REVIEW: [],
}

export class IllegalPayoutTransition extends Error {
  constructor(readonly from: PayoutStatus, readonly to: PayoutStatus) {
    super(`Illegal payout transition ${from} → ${to}`)
    this.name = 'IllegalPayoutTransition'
  }
}

export function canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  if (from === to) return true // idempotent re-application of the same status
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function assertTransition(from: PayoutStatus, to: PayoutStatus): void {
  if (!canTransition(from, to)) throw new IllegalPayoutTransition(from, to)
}

/** Statuses the background worker should pick up. */
export const WORKABLE_STATUSES: readonly PayoutStatus[] = ['CREATED', 'FAILED']

/** Statuses the reconciler should poll the provider about. */
export const IN_FLIGHT_STATUSES: readonly PayoutStatus[] = ['SUBMITTED', 'PROCESSING']

// ─── Retry policy ────────────────────────────────────────────────────────────

/** After this many failed attempts the payout goes to MANUAL_REVIEW. */
export const MAX_PAYOUT_ATTEMPTS = 5

/**
 * Exponential backoff with jitter, in milliseconds.
 * attempt 1 → ~1m, 2 → ~5m, 3 → ~15m, 4 → ~1h, 5 → ~4h.
 *
 * Jitter matters: without it, a provider outage causes every queued payout to
 * retry in lockstep and hammer the provider the moment it recovers.
 */
const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 14_400_000]

export function nextAttemptDelayMs(attempts: number): number {
  const base = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]
  const jitter = Math.floor(base * 0.2 * Math.random())
  return base + jitter
}

/**
 * How long a payout may sit in SUBMITTED/PROCESSING before the reconciler
 * escalates it to MANUAL_REVIEW. Real rails settle well inside this; anything
 * slower needs a human to look at it rather than another automated attempt.
 */
export const STALE_IN_FLIGHT_MS = 6 * 60 * 60 * 1000 // 6 hours
