/**
 * lib/compliance/screening.ts
 *
 * Sanctions and PEP screening for both sides of a transfer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Cross-border money transmission requires screening the sender and the
 * recipient against sanctions lists before value moves, and being able to show
 * afterwards that you did. There was no hook for it at all — LAUNCH.md §3
 * listed it as an open item with nowhere to put the code.
 *
 * The shape mirrors the payout providers: an interface, a registry, a
 * fail-closed default, and a durable record of every decision. Wiring a real
 * vendor (ComplyAdvantage, Chainalysis, Refinitiv, Sanctions.io) means writing
 * one `ScreeningProvider` and naming it in SCREENING_PROVIDER.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FAIL-CLOSED
 * ─────────────────────────────────────────────────────────────────────────────
 * On a production chain with no provider configured, screening returns BLOCK
 * and the send is refused. That is deliberate and consistent with how payouts
 * and KYC behave here: an unscreened transfer is a compliance breach, and
 * "allow by default because nothing is set up" is how those happen.
 *
 * Off a production chain it returns ALLOW so local development works.
 */

import 'server-only'
import { createHmac } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, screeningRecords, screeningDenylist } from '@/lib/db'
import { IS_PRODUCTION_CHAIN } from '@/lib/env'
import { log } from '@/lib/http'

// ─── Types ───────────────────────────────────────────────────────────────────

export type ScreeningDecision = 'ALLOW' | 'REVIEW' | 'BLOCK'

export interface ScreeningSubject {
  type: 'sender' | 'recipient'
  /** Wallet address for a sender, E.164 phone for a recipient. */
  value: string
  /** Safe-to-display form. */
  masked: string
}

export interface ScreeningContext {
  transferId?: string
  corridor: string
  /** QUSD base units. */
  amount: string
}

export interface ScreeningResult {
  decision: ScreeningDecision
  provider: string
  /** Why, in terms a compliance officer can act on. Never raw PII. */
  reason?: string
  matchDetail?: Record<string, unknown>
}

export interface ScreeningProvider {
  readonly id: string
  /** False for anything that does not consult a real sanctions source. */
  readonly isLive: boolean
  screen(subject: ScreeningSubject, context: ScreeningContext): Promise<ScreeningResult>
}

// ─── Subject hashing ─────────────────────────────────────────────────────────

/**
 * Keyed hash of a screened value.
 *
 * Screening records and the denylist are matched on this, never on the raw
 * address or phone number — a database compromise should not yield a list of
 * who was screened or who is denied. Keyed with PHONE_HASH_PEPPER so the hash
 * cannot be recomputed from a candidate list without the secret.
 */
export function subjectHash(value: string): string {
  const pepper = process.env.PHONE_HASH_PEPPER
  if (!pepper) throw new Error('PHONE_HASH_PEPPER is required for screening')
  return createHmac('sha256', pepper).update(value.toLowerCase()).digest('hex')
}

// ─── Providers ───────────────────────────────────────────────────────────────

/**
 * Denylist provider.
 *
 * Checks the operator-maintained `screening_denylist` table. Genuinely useful
 * on its own — it enforces internal blocks, court orders and chargeback bans —
 * but it is NOT a sanctions list: it only knows what has been added to it.
 * `isLive` is false so nothing can mistake it for real sanctions coverage.
 */
const denylistProvider: ScreeningProvider = {
  id: 'denylist',
  isLive: false,

  async screen(subject): Promise<ScreeningResult> {
    if (!db) return { decision: 'REVIEW', provider: 'denylist', reason: 'Database unavailable' }

    const kind = subject.type === 'sender' ? 'address' : 'phone'
    const rows = await db
      .select()
      .from(screeningDenylist)
      .where(
        and(
          eq(screeningDenylist.kind, kind),
          eq(screeningDenylist.valueHash, subjectHash(subject.value)),
          eq(screeningDenylist.active, true),
        ),
      )
      .limit(1)

    if (rows[0]) {
      return {
        decision: 'BLOCK',
        provider: 'denylist',
        reason: rows[0].reason,
        matchDetail: { listEntryId: rows[0].id },
      }
    }

    return { decision: 'ALLOW', provider: 'denylist' }
  },
}

/** Development only. Never selected on a production chain. */
const permissiveProvider: ScreeningProvider = {
  id: 'none',
  isLive: false,
  async screen(): Promise<ScreeningResult> {
    return { decision: 'ALLOW', provider: 'none', reason: 'Screening is not configured' }
  },
}

const PROVIDERS: Record<string, ScreeningProvider> = {
  denylist: denylistProvider,
  none: permissiveProvider,
}

/**
 * Resolve the configured provider.
 *
 * Returns null on a production chain when nothing usable is configured, which
 * `screenTransfer` turns into a BLOCK.
 */
export function getScreeningProvider(): ScreeningProvider | null {
  const configured = process.env.SCREENING_PROVIDER

  if (configured) {
    const provider = PROVIDERS[configured]
    if (provider) {
      // The permissive provider must never be selectable on mainnet.
      if (IS_PRODUCTION_CHAIN && provider.id === 'none') return null
      return provider
    }
    log('error', 'screening.unknown_provider', { provider: configured })
    return null
  }

  return IS_PRODUCTION_CHAIN ? null : permissiveProvider
}

export function isScreeningConfigured(): boolean {
  return getScreeningProvider() !== null
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export interface TransferScreeningResult {
  decision: ScreeningDecision
  /** Set when the decision is BLOCK or REVIEW. Safe to show the sender. */
  reason?: string
}

/**
 * Screen both parties. The strictest outcome wins.
 *
 * Called from /api/transfers/prepare BEFORE the FX quote and before any
 * credential is minted, so a blocked transfer never reaches the chain.
 */
export async function screenTransfer(
  subjects: ScreeningSubject[],
  context: ScreeningContext,
): Promise<TransferScreeningResult> {
  const provider = getScreeningProvider()

  if (!provider) {
    log('error', 'screening.not_configured', { corridor: context.corridor })
    return {
      decision: 'BLOCK',
      reason: 'Transfers are temporarily unavailable. Please try again later.',
    }
  }

  let worst: ScreeningDecision = 'ALLOW'
  let reason: string | undefined

  for (const subject of subjects) {
    let result: ScreeningResult
    try {
      result = await provider.screen(subject, context)
    } catch (err) {
      // A screening provider that errors must not become an implicit allow.
      log('error', 'screening.provider_failed', {
        provider: provider.id,
        subject: subject.type,
        err: String(err).slice(0, 200),
      })
      result = {
        decision: 'REVIEW',
        provider: provider.id,
        reason: 'Screening provider unavailable',
      }
    }

    await recordScreening(subject, context, result)

    if (result.decision === 'BLOCK') {
      worst = 'BLOCK'
      reason = result.reason
      break // no need to keep screening once blocked
    }
    if (result.decision === 'REVIEW' && worst === 'ALLOW') {
      worst = 'REVIEW'
      reason = result.reason
    }
  }

  if (worst === 'BLOCK') {
    log('warn', 'screening.blocked', { corridor: context.corridor, reason })
    return {
      decision: 'BLOCK',
      // Never tell the subject they matched a sanctions list — that is tipping
      // off, and in most jurisdictions it is itself an offence.
      reason: 'We are unable to process this transfer. Please contact support.',
    }
  }

  if (worst === 'REVIEW') {
    log('warn', 'screening.review', { corridor: context.corridor, reason })
    return {
      decision: 'REVIEW',
      reason: 'This transfer needs a manual check before it can proceed. We will be in touch shortly.',
    }
  }

  return { decision: 'ALLOW' }
}

async function recordScreening(
  subject: ScreeningSubject,
  context: ScreeningContext,
  result: ScreeningResult,
): Promise<void> {
  if (!db) return
  try {
    await db.insert(screeningRecords).values({
      transferId: context.transferId ?? null,
      subjectType: subject.type,
      subjectHash: subjectHash(subject.value),
      subjectMasked: subject.masked,
      decision: result.decision,
      provider: result.provider,
      matchDetail: result.matchDetail ? JSON.stringify(result.matchDetail) : null,
      corridor: context.corridor,
      amount: context.amount,
      createdAt: Date.now(),
    })
  } catch (err) {
    // An unrecorded screening is a compliance gap, so this is loud — but it
    // must not fail the request, or a database hiccup blocks all sending.
    log('error', 'screening.record_failed', { err: String(err).slice(0, 200) })
  }
}

// ─── Denylist management ─────────────────────────────────────────────────────

export async function addToDenylist(input: {
  kind: 'address' | 'phone'
  value: string
  masked: string
  reason: string
  addedBy: string
}): Promise<void> {
  if (!db) throw new Error('Database unavailable')
  await db
    .insert(screeningDenylist)
    .values({
      kind: input.kind,
      valueHash: subjectHash(input.value),
      valueMasked: input.masked,
      reason: input.reason,
      addedBy: input.addedBy,
      active: true,
      createdAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [screeningDenylist.kind, screeningDenylist.valueHash],
      set: { active: true, reason: input.reason, addedBy: input.addedBy },
    })
}
