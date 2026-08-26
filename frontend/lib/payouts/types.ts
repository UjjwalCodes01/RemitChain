/**
 * lib/payouts/types.ts
 *
 * The contract every payout provider implements.
 *
 * A provider is the thing that actually moves fiat into the recipient's bank
 * account or mobile wallet. Adding a corridor means writing one of these and
 * listing it in the corridor's `providers` array — nothing else in the system
 * needs to change.
 */

import type { Corridor, ProviderId } from '@/lib/corridors'

// ─── Payout lifecycle ────────────────────────────────────────────────────────

/**
 * CREATED       Ledger row written. Money has NOT been requested yet.
 * SUBMITTED     Handed to the provider; awaiting their acknowledgement.
 * PROCESSING    Provider accepted it and is moving the money.
 * PAID          Provider confirmed settlement. Terminal, success.
 * FAILED        Provider rejected or the attempt errored. Retryable.
 * REVERSED      Provider returned the money after initially accepting it.
 * MANUAL_REVIEW Out of retries, or an ambiguous state. Terminal until a human
 *               resolves it. NEVER auto-retried — an ambiguous payout is the
 *               one case where retrying risks paying twice.
 */
export type PayoutStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'PROCESSING'
  | 'PAID'
  | 'FAILED'
  | 'REVERSED'
  | 'MANUAL_REVIEW'

export const TERMINAL_STATUSES: readonly PayoutStatus[] = ['PAID', 'REVERSED', 'MANUAL_REVIEW']

export function isTerminal(status: PayoutStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

// ─── Provider request / response ─────────────────────────────────────────────

export interface CreatePayoutRequest {
  /** Stable idempotency key. The same key must never pay twice. */
  idempotencyKey: string
  corridor: Corridor
  /** Validated, normalised destination (UPI VPA, CLABE, wallet number…). */
  destination: string
  /** Amount in the recipient currency's MINOR units (paise, centavos…). */
  amountMinor: number
  currency: string
  /** Free-text reference shown on the recipient's statement. */
  narration: string
  /** Correlates provider records back to the transfer. */
  transferId: string
  /**
   * Provider-side beneficiary handle from a previous attempt, if any.
   * Passing it back lets a retry reuse the existing fund account instead of
   * creating a duplicate beneficiary on every attempt.
   */
  existingAccountRef?: string | null
}

export interface ProviderPayoutResult {
  /** Provider's own identifier for this payout. */
  providerRef: string
  /** Raw provider status string, kept verbatim for support and audit. */
  providerStatus: string
  /** Normalised status. */
  status: PayoutStatus
  /** Bank UTR / trace number once settled. */
  utr?: string
  /** Provider-side beneficiary handle, persisted for retries. */
  providerAccountRef?: string
}

/**
 * Thrown when a provider call fails in a way that is safe to retry.
 * Network timeouts, 5xx, rate limits.
 */
export class RetryablePayoutError extends Error {
  readonly retryable = true as const
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'RetryablePayoutError'
  }
}

/**
 * Thrown when a provider call fails in a way that will never succeed on retry.
 * Invalid destination, insufficient provider balance, rejected KYC.
 */
export class PermanentPayoutError extends Error {
  readonly retryable = false as const
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'PermanentPayoutError'
  }
}

/**
 * Thrown when we cannot tell whether the money moved. The payout goes straight
 * to MANUAL_REVIEW and is never retried automatically, because a retry could
 * pay the recipient twice.
 */
export class AmbiguousPayoutError extends Error {
  readonly retryable = false as const
  readonly ambiguous = true as const
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'AmbiguousPayoutError'
  }
}

// ─── Webhook verification ────────────────────────────────────────────────────

export interface WebhookVerification {
  ok: boolean
  /** Provider's unique event id — used to de-duplicate replays. */
  eventId?: string
  eventType?: string
  /** Provider's payout id this event refers to. */
  providerRef?: string
  status?: PayoutStatus
  providerStatus?: string
  utr?: string
  error?: string
}

// ─── The interface ───────────────────────────────────────────────────────────

export interface PayoutProvider {
  readonly id: ProviderId

  /**
   * Whether this provider moves real money. `false` means it simulates, and
   * the rest of the system must surface that honestly to the user rather than
   * reporting a completed payout.
   */
  readonly isLive: boolean

  /**
   * Request a payout. MUST be idempotent on `idempotencyKey`: calling twice
   * with the same key must never move money twice, and should return the
   * original result.
   */
  createPayout(req: CreatePayoutRequest): Promise<ProviderPayoutResult>

  /** Poll current state. Used by the reconciler for payouts stuck in flight. */
  getPayout(providerRef: string): Promise<ProviderPayoutResult>

  /**
   * Verify and parse an inbound webhook.
   * `rawBody` must be the exact bytes received — signature checks are computed
   * over the raw body, so it can never be re-serialised from parsed JSON.
   */
  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification
}
