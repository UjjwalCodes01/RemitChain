/**
 * lib/payouts/ledger.ts
 *
 * Creating, claiming and advancing payout records.
 *
 * Two invariants hold everywhere in this file:
 *
 *   1. A payout row is only ever created AFTER the on-chain claim has been
 *      mined. Fiat never leaves before the escrow releases. The previous
 *      implementation had this backwards.
 *
 *   2. A row is claimed for work with a conditional UPDATE … RETURNING, so two
 *      concurrent workers (which serverless cron will produce) cannot both
 *      submit the same payout.
 */

import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { db, payouts, transfers } from '@/lib/db'
import type { Payout } from '@/lib/db/schema'
import { getCorridorById, maskDestination, validateDestination, resolveProviderId } from '@/lib/corridors'
import type { Corridor } from '@/lib/corridors'
import { getProvider, isLegacyProvider } from './registry'
import {
  assertTransition,
  IN_FLIGHT_STATUSES,
  MAX_PAYOUT_ATTEMPTS,
  nextAttemptDelayMs,
  STALE_IN_FLIGHT_MS,
  WORKABLE_STATUSES,
} from './state'
import {
  AmbiguousPayoutError,
  isTerminal,
  PermanentPayoutError,
  type PayoutStatus,
  type ProviderPayoutResult,
} from './types'

// ─── Logging ─────────────────────────────────────────────────────────────────

export function logPayout(
  level: 'info' | 'warn' | 'error',
  step: string,
  meta: Record<string, unknown> = {},
) {
  // Destinations and full transfer ids never appear here — callers pass masked
  // values. Anything money-related is logged so it can be reconciled later.
  console.log(JSON.stringify({ level, step, ts: new Date().toISOString(), ...meta }))
}

// ─── Creation ────────────────────────────────────────────────────────────────

export interface EnqueuePayoutInput {
  transferId: string
  corridorId: string
  /** Raw destination as supplied by the recipient. Validated here. */
  destination: string
  /** Net QUSD base units actually released from escrow (amount - fee). */
  netAmountBaseUnits: bigint
  /** FX rate locked at send time, if the transfer carries one. */
  quotedRate?: string | null
  quotedLocalMinor?: string | null
}

export type EnqueueResult =
  | { ok: true; payout: Payout; created: boolean }
  | { ok: false; error: string; code: 'CORRIDOR_CLOSED' | 'INVALID_DESTINATION' | 'NO_DB' | 'FX_UNAVAILABLE' }

/**
 * Write the payout row. Idempotent on `transferId` — a second call returns the
 * existing row rather than creating a second payment.
 */
export async function enqueuePayout(
  input: EnqueuePayoutInput,
  isProductionChain: boolean,
): Promise<EnqueueResult> {
  if (!db) return { ok: false, error: 'Database is not configured', code: 'NO_DB' }

  const corridor = getCorridorById(input.corridorId)
  if (!corridor) {
    return { ok: false, error: `Unknown corridor ${input.corridorId}`, code: 'CORRIDOR_CLOSED' }
  }

  const providerId = resolveProviderId(corridor, isProductionChain)
  if (!providerId) {
    return {
      ok: false,
      error: `The ${corridor.rail} payout rail is not available`,
      code: 'CORRIDOR_CLOSED',
    }
  }

  const validated = validateDestination(corridor, input.destination)
  if (!validated.ok) {
    return { ok: false, error: validated.error!, code: 'INVALID_DESTINATION' }
  }

  // Existing row wins — never create a second payout for a transfer.
  const existing = await db.select().from(payouts).where(eq(payouts.transferId, input.transferId)).limit(1)
  if (existing[0]) {
    return { ok: true, payout: existing[0], created: false }
  }

  const quote = await resolvePayoutAmount(corridor, input)
  if (!quote) {
    return {
      ok: false,
      error: 'Could not determine an exchange rate for this payout',
      code: 'FX_UNAVAILABLE',
    }
  }

  const now = Date.now()
  const [row] = await db
    .insert(payouts)
    .values({
      transferId: input.transferId,
      provider: providerId,
      corridor: corridor.id,
      rail: corridor.rail,
      destination: validated.value,
      destinationMasked: maskDestination(corridor, validated.value),
      amountMinor: String(quote.amountMinor),
      currency: corridor.currency,
      sourceAmount: input.netAmountBaseUnits.toString(),
      fxRate: quote.rate,
      fxSource: quote.source,
      status: 'CREATED',
      idempotencyKey: `rc_${input.transferId.slice(2, 34)}`,
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    })
    // Concurrent claims can race here; the unique index on transfer_id makes
    // the loser a no-op rather than a duplicate payment.
    .onConflictDoNothing({ target: payouts.transferId })
    .returning()

  if (!row) {
    const raced = await db.select().from(payouts).where(eq(payouts.transferId, input.transferId)).limit(1)
    if (raced[0]) return { ok: true, payout: raced[0], created: false }
    return { ok: false, error: 'Failed to create the payout record', code: 'NO_DB' }
  }

  logPayout('info', 'payout.created', {
    payoutId: row.id,
    corridor: corridor.id,
    rail: corridor.rail,
    provider: providerId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    destination: row.destinationMasked,
  })

  return { ok: true, payout: row, created: true }
}

// ─── Amount resolution ───────────────────────────────────────────────────────

interface PayoutQuote {
  amountMinor: number
  rate: string
  /** 'quote' = the rate locked at send time; otherwise how it was sourced now. */
  source: 'quote' | 'live' | 'cached'
}

/**
 * Work out what the recipient is paid.
 *
 * Preference order:
 *   1. The rate quoted to the sender at send time. Honouring it is the whole
 *      point of locking a quote — the recipient gets what the sender was shown.
 *   2. A live rate at claim time.
 *
 * Note this converts `netAmountBaseUnits` (post-fee). The previous code
 * converted the gross on-chain `amount`, paying out 0.1% more than escrow
 * actually released on every single transfer.
 */
async function resolvePayoutAmount(
  corridor: Corridor,
  input: EnqueuePayoutInput,
): Promise<PayoutQuote | null> {
  if (input.quotedLocalMinor && input.quotedRate) {
    const minor = Number(input.quotedLocalMinor)
    if (Number.isFinite(minor) && minor > 0) {
      return { amountMinor: Math.round(minor), rate: input.quotedRate, source: 'quote' }
    }
  }

  // No locked quote (a transfer that predates this field, or one reconstructed
  // from chain). Price it now. A null rate means we genuinely do not know what
  // to pay, so the payout is not created rather than guessed at.
  const { getFxRate, convertToMinor } = await import('@/lib/fx/rates')
  const quote = await getFxRate(corridor.currency)
  if (!quote) return null

  const amountMinor = convertToMinor(input.netAmountBaseUnits, quote.rate, corridor.minorUnits)
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) return null

  return { amountMinor, rate: String(quote.rate), source: quote.source }
}

// ─── Claiming work ───────────────────────────────────────────────────────────

/**
 * Atomically take ownership of a payout for submission.
 *
 * The conditional WHERE is the lock: only one caller can move a row out of
 * CREATED/FAILED, so two concurrent cron invocations cannot double-submit.
 * Returns null if another worker got there first.
 */
async function claimForSubmission(payoutId: string): Promise<Payout | null> {
  if (!db) return null
  const now = Date.now()

  const [row] = await db
    .update(payouts)
    .set({
      status: 'SUBMITTED',
      attempts: sql`${payouts.attempts} + 1`,
      submittedAt: now,
      updatedAt: now,
      // Park the next retry beyond the current attempt window so a crash
      // mid-submit does not cause an immediate re-run.
      nextAttemptAt: now + nextAttemptDelayMs(0),
    })
    .where(
      and(
        eq(payouts.id, payoutId),
        inArray(payouts.status, [...WORKABLE_STATUSES]),
      ),
    )
    .returning()

  return row ?? null
}

// ─── Applying results ────────────────────────────────────────────────────────

export async function applyProviderResult(
  payoutId: string,
  result: ProviderPayoutResult,
): Promise<void> {
  if (!db) return

  const [current] = await db.select().from(payouts).where(eq(payouts.id, payoutId)).limit(1)
  if (!current) return

  const from = current.status as PayoutStatus

  // A terminal row is final. Late webhooks and reconciler races land here, and
  // silently ignoring them is exactly right: nothing may un-pay a payout.
  if (isTerminal(from)) {
    if (from !== result.status) {
      logPayout('warn', 'payout.ignored_after_terminal', {
        payoutId,
        from,
        attempted: result.status,
        providerStatus: result.providerStatus,
      })
    }
    return
  }

  try {
    assertTransition(from, result.status)
  } catch {
    logPayout('error', 'payout.illegal_transition', {
      payoutId,
      from,
      to: result.status,
      providerStatus: result.providerStatus,
    })
    return
  }

  const now = Date.now()
  const patch: Partial<typeof payouts.$inferInsert> = {
    status: result.status,
    providerRef: result.providerRef || current.providerRef,
    providerStatus: result.providerStatus,
    updatedAt: now,
  }
  if (result.utr) patch.providerUtr = result.utr
  if (result.providerAccountRef) patch.providerAccountRef = result.providerAccountRef
  if (result.status === 'PAID') {
    patch.paidAt = now
    patch.lastError = null
    patch.nextAttemptAt = null
  }
  if (result.status === 'FAILED') {
    const attempts = current.attempts
    patch.nextAttemptAt = now + nextAttemptDelayMs(attempts)
    if (attempts >= MAX_PAYOUT_ATTEMPTS) {
      patch.status = 'MANUAL_REVIEW'
      patch.nextAttemptAt = null
      patch.lastError = `Exhausted ${MAX_PAYOUT_ATTEMPTS} attempts. Last provider status: ${result.providerStatus}`
    }
  }

  await db.update(payouts).set(patch).where(eq(payouts.id, payoutId))

  logPayout(result.status === 'PAID' ? 'info' : 'warn', `payout.${(patch.status ?? result.status).toLowerCase()}`, {
    payoutId,
    from,
    to: patch.status ?? result.status,
    providerRef: result.providerRef,
    providerStatus: result.providerStatus,
    utr: result.utr,
  })
}

async function recordFailure(
  payout: Payout,
  err: unknown,
  opts: { ambiguous?: boolean; permanent?: boolean } = {},
): Promise<void> {
  if (!db) return

  const message = err instanceof Error ? err.message : String(err)
  const now = Date.now()
  const attempts = payout.attempts + 1

  // Ambiguous means we do not know whether the money moved. Retrying could pay
  // twice, so it goes to a human immediately and never re-enters the queue.
  const exhausted = attempts >= MAX_PAYOUT_ATTEMPTS
  const status: PayoutStatus =
    opts.ambiguous || opts.permanent || exhausted ? 'MANUAL_REVIEW' : 'FAILED'

  await db
    .update(payouts)
    .set({
      status,
      lastError: message.slice(0, 500),
      updatedAt: now,
      nextAttemptAt: status === 'FAILED' ? now + nextAttemptDelayMs(attempts) : null,
    })
    .where(eq(payouts.id, payout.id))

  logPayout('error', 'payout.attempt_failed', {
    payoutId: payout.id,
    attempts,
    status,
    ambiguous: Boolean(opts.ambiguous),
    permanent: Boolean(opts.permanent),
    error: message.slice(0, 300),
  })
}

// ─── Submission ──────────────────────────────────────────────────────────────

/**
 * Submit one payout to its provider.
 * Safe to call concurrently: the atomic claim means only one caller proceeds.
 */
export async function submitPayout(payoutId: string): Promise<void> {
  const claimed = await claimForSubmission(payoutId)
  if (!claimed) return // another worker owns it

  if (isLegacyProvider(claimed.provider)) {
    await recordFailure(claimed, new Error('Legacy payout record — resolve manually'), { permanent: true })
    return
  }

  const provider = getProvider(claimed.provider)
  if (!provider) {
    await recordFailure(claimed, new Error(`Unknown provider "${claimed.provider}"`), { permanent: true })
    return
  }

  const corridor = getCorridorById(claimed.corridor)
  if (!corridor) {
    await recordFailure(claimed, new Error(`Unknown corridor "${claimed.corridor}"`), { permanent: true })
    return
  }

  try {
    const result = await provider.createPayout({
      idempotencyKey: claimed.idempotencyKey,
      corridor,
      destination: claimed.destination,
      amountMinor: Number(claimed.amountMinor),
      currency: claimed.currency,
      narration: 'RemitChain payout',
      transferId: claimed.transferId,
      existingAccountRef: claimed.providerAccountRef,
    })
    await applyProviderResult(claimed.id, result)
  } catch (err) {
    if (err instanceof AmbiguousPayoutError) {
      await recordFailure(claimed, err, { ambiguous: true })
    } else if (err instanceof PermanentPayoutError) {
      await recordFailure(claimed, err, { permanent: true })
    } else {
      await recordFailure(claimed, err)
    }
  }
}

// ─── Worker & reconciler ─────────────────────────────────────────────────────

export interface WorkerReport {
  submitted: number
  reconciled: number
  escalated: number
}

/** Submit every payout that is due. */
export async function runPayoutWorker(limit = 25): Promise<number> {
  if (!db) return 0
  const now = Date.now()

  const due = await db
    .select({ id: payouts.id })
    .from(payouts)
    .where(
      and(
        inArray(payouts.status, [...WORKABLE_STATUSES]),
        or(isNull(payouts.nextAttemptAt), lt(payouts.nextAttemptAt, now)),
      ),
    )
    .limit(limit)

  // Sequential on purpose. These are money-moving calls against a provider
  // with rate limits; a burst of parallel requests risks 429s that look like
  // failures and burn retry budget.
  for (const { id } of due) {
    await submitPayout(id)
  }

  return due.length
}

/**
 * Poll the provider for payouts that are in flight.
 *
 * Webhooks are the primary settlement signal; this is the backstop for when a
 * webhook is dropped, mis-delivered, or the provider does not send them.
 */
export async function runPayoutReconciler(limit = 25): Promise<{ reconciled: number; escalated: number }> {
  if (!db) return { reconciled: 0, escalated: 0 }
  const now = Date.now()

  const inFlight = await db
    .select()
    .from(payouts)
    .where(inArray(payouts.status, [...IN_FLIGHT_STATUSES]))
    .limit(limit)

  let reconciled = 0
  let escalated = 0

  for (const row of inFlight) {
    const provider = getProvider(row.provider)

    if (!provider || !row.providerRef) {
      // In flight with nothing to poll. If it has been stuck a long time, a
      // human needs to look at it.
      if (now - row.updatedAt > STALE_IN_FLIGHT_MS) {
        await db
          .update(payouts)
          .set({
            status: 'MANUAL_REVIEW',
            lastError: 'In flight with no provider reference to reconcile against',
            nextAttemptAt: null,
            updatedAt: now,
          })
          .where(eq(payouts.id, row.id))
        escalated++
      }
      continue
    }

    try {
      const result = await provider.getPayout(row.providerRef)
      if (result.status !== row.status) {
        await applyProviderResult(row.id, result)
        reconciled++
      } else if (now - row.updatedAt > STALE_IN_FLIGHT_MS) {
        await db
          .update(payouts)
          .set({
            status: 'MANUAL_REVIEW',
            lastError: `Stuck in ${row.status} for over ${Math.round(STALE_IN_FLIGHT_MS / 3_600_000)}h (provider: ${result.providerStatus})`,
            nextAttemptAt: null,
            updatedAt: now,
          })
          .where(eq(payouts.id, row.id))
        escalated++
      }
    } catch (err) {
      logPayout('warn', 'payout.reconcile_failed', {
        payoutId: row.id,
        error: String(err).slice(0, 200),
      })
    }
  }

  return { reconciled, escalated }
}

// ─── Read helpers ────────────────────────────────────────────────────────────

/** Public-safe view of a payout. Never exposes the full destination. */
export interface PublicPayout {
  status: PayoutStatus
  rail: string
  currency: string
  amountMinor: string
  destinationMasked: string
  utr: string | null
  reference: string | null
  /** False when the payout was serviced by a simulated rail. */
  live: boolean
  paidAt: number | null
  updatedAt: number
}

export function toPublicPayout(row: Payout): PublicPayout {
  const provider = getProvider(row.provider)
  return {
    status: row.status as PayoutStatus,
    rail: row.rail,
    currency: row.currency,
    amountMinor: row.amountMinor,
    destinationMasked: row.destinationMasked,
    utr: row.providerUtr,
    reference: row.providerRef,
    live: provider?.isLive ?? false,
    paidAt: row.paidAt,
    updatedAt: row.updatedAt,
  }
}

export async function getPayoutForTransfer(transferId: string): Promise<Payout | null> {
  if (!db) return null
  const rows = await db.select().from(payouts).where(eq(payouts.transferId, transferId)).limit(1)
  return rows[0] ?? null
}

export async function getPayoutByProviderRef(
  provider: string,
  providerRef: string,
): Promise<Payout | null> {
  if (!db) return null
  const rows = await db
    .select()
    .from(payouts)
    .where(and(eq(payouts.provider, provider), eq(payouts.providerRef, providerRef)))
    .limit(1)
  return rows[0] ?? null
}

/** Transfers whose money has settled on-chain but which have no payout row. */
export async function findOrphanedClaims(limit = 20) {
  if (!db) return []
  return db
    .select({
      id: transfers.id,
      corridor: transfers.corridor,
      netAmount: transfers.netAmount,
      amount: transfers.amount,
      claimedAt: transfers.claimedAt,
    })
    .from(transfers)
    .leftJoin(payouts, eq(payouts.transferId, transfers.id))
    .where(and(eq(transfers.status, 1), isNull(payouts.id)))
    .limit(limit)
}
