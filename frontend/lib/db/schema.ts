/**
 * lib/db/schema.ts
 *
 * Drizzle ORM schema for RemitChain Postgres (Neon serverless).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONVENTIONS — read before adding a column
 * ─────────────────────────────────────────────────────────────────────────────
 *  - transferId : bytes32 hex string (0x…) stored as text, primary key
 *  - amounts    : text (bigint serialised — Postgres bigint loses precision in JS)
 *  - timestamps : `bigint` holding UNIX EPOCH MILLISECONDS. Always ms, always
 *                 bigint, no exceptions.
 *
 * The timestamp rule is not cosmetic. The previous schema declared these
 * columns `integer` (int4, max 2,147,483,647) while the application wrote
 * `Date.now()` (~1.77e12) into `schedules.next_run_at`,
 * `push_subscriptions.created_at` and `analytics_events.created_at`. Every one
 * of those inserts failed with "value out of range for type integer" — creating
 * a schedule was a hard 500 whenever a database was configured. Meanwhile the
 * `transfers` table was written in *seconds* by the application but defaulted
 * to *milliseconds* in DDL, so the same column held both units.
 *
 * Migration 0001 widens every timestamp to bigint and rescales the
 * seconds-valued rows to milliseconds.
 */

import {
  pgTable,
  text,
  integer,
  bigint,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/** Epoch-milliseconds column. Use this for every timestamp. */
const epochMs = (name: string) => bigint(name, { mode: 'number' })

// ── transfers ────────────────────────────────────────────────────────────────
// Mirror of the on-chain transfer struct plus off-chain metadata.
// The contract is always the source of truth for money; this table is the
// metadata and workflow layer.

export const transfers = pgTable(
  'transfers',
  {
    // On-chain identity
    id: text('id').primaryKey(),                  // transferId (bytes32 hex)
    txHash: text('tx_hash'),                      // sendRemittance() tx hash
    claimTxHash: text('claim_tx_hash'),           // claimRemittance() tx hash
    senderAddress: text('sender_address').notNull(),
    recipientPhoneHash: text('recipient_phone_hash').notNull(),
    senderNonce: bigint('sender_nonce', { mode: 'number' }),

    // Recipient contact. The full phone number is never persisted — only the
    // on-chain commitment above and a masked form for support tooling.
    recipientPhoneMasked: text('recipient_phone_masked'),
    recipientEmail: text('recipient_email'),
    recipientNickname: text('recipient_nickname'),  // e.g. "Mom" — never hits chain

    // Financial. Gross is what leaves the sender; net is what the recipient is
    // owed after the protocol fee. The off-ramp must always pay `netAmount` —
    // the old code converted the gross figure and overpaid by the fee.
    amount: text('amount').notNull(),             // gross QUSD base units
    feeAmount: text('fee_amount'),                // protocol fee, QUSD base units
    netAmount: text('net_amount'),                // amount - fee, QUSD base units
    corridor: text('corridor').notNull(),

    // FX quoted and locked at send time, so the recipient is paid the rate the
    // sender was shown rather than whatever the rate happens to be at claim.
    quotedRate: text('quoted_rate'),              // decimal string, USD → local
    quotedCurrency: text('quoted_currency'),      // ISO-4217
    quotedLocalMinor: text('quoted_local_minor'), // payout amount in minor units
    quotedAt: epochMs('quoted_at'),

    // Claim credentials, encrypted at rest (AES-256-GCM, SECRETS_ENCRYPTION_KEY).
    // Retained only so the notification can be re-sent; wiped on terminal state.
    claimSecretEnc: text('claim_secret_enc'),
    otpEnc: text('otp_enc'),

    // On-chain status, synced by the event listener.
    // 0=PENDING 1=CLAIMED 2=CANCELLED
    status: integer('status').notNull().default(0),

    // Notification delivery
    notifyChannel: text('notify_channel'),                       // email | sms
    notifyStatus: text('notify_status').notNull().default('PENDING'), // PENDING|SENT|FAILED
    notifyAttempts: integer('notify_attempts').notNull().default(0),
    notifyLastError: text('notify_last_error'),

    // Timestamps (epoch ms)
    createdAt: epochMs('created_at').notNull().default(sql`(extract(epoch from now()) * 1000)::bigint`),
    updatedAt: epochMs('updated_at').notNull().default(sql`(extract(epoch from now()) * 1000)::bigint`),
    claimedAt: epochMs('claimed_at'),
    cancelledAt: epochMs('cancelled_at'),
    expiry: epochMs('expiry'),                    // mirrors on-chain expiry
  },
  (t) => [
    index('idx_transfers_sender').on(t.senderAddress),
    index('idx_transfers_status').on(t.status),
    index('idx_transfers_created').on(t.createdAt),
    index('idx_transfers_phone_hash').on(t.recipientPhoneHash),
  ],
)

// ── payouts ──────────────────────────────────────────────────────────────────
// The fiat side of the ledger. One row per transfer, created only AFTER the
// on-chain claim has been mined.
//
// This table did not exist before. Payouts were fired inline from the claim
// route with no record, no retry and no reconciliation — and, critically, they
// were fired BEFORE the on-chain settlement, so a failed broadcast meant money
// had already left the treasury against an escrow that never released.

export const payouts = pgTable(
  'payouts',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),

    // One payout per transfer, enforced by the database. This is the outermost
    // idempotency guard: a duplicate enqueue cannot create a second payment.
    transferId: text('transfer_id').notNull().references(() => transfers.id, { onDelete: 'restrict' }),

    provider: text('provider').notNull(),          // razorpay | sandbox
    corridor: text('corridor').notNull(),
    rail: text('rail').notNull(),                  // UPI | SPEI | …

    // Destination. Full value is needed to actually pay, so it is stored, but
    // only the masked form is ever logged or returned by the API.
    destination: text('destination').notNull(),
    destinationMasked: text('destination_masked').notNull(),

    // Money
    amountMinor: text('amount_minor').notNull(),   // payout amount, minor units
    currency: text('currency').notNull(),
    sourceAmount: text('source_amount').notNull(), // net QUSD base units settled
    fxRate: text('fx_rate').notNull(),
    fxSource: text('fx_source').notNull(),         // 'quote' | 'live' | 'seeded'

    // State machine — see lib/payouts/state.ts for legal transitions.
    // CREATED → SUBMITTED → PROCESSING → PAID
    //                    ↘ FAILED → (retry) → SUBMITTED
    //                    ↘ MANUAL_REVIEW  (terminal, needs a human)
    //         REVERSED (provider returned the funds)
    status: text('status').notNull().default('CREATED'),

    // Provider correlation
    idempotencyKey: text('idempotency_key').notNull(),
    providerRef: text('provider_ref'),             // provider's payout id
    /** Provider-side beneficiary handle (e.g. Razorpay fund_account_id), reused across retries. */
    providerAccountRef: text('provider_account_ref'),
    providerStatus: text('provider_status'),       // raw provider status string
    providerUtr: text('provider_utr'),             // bank UTR / trace number

    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Earliest time the worker may next touch this row (backoff). */
    nextAttemptAt: epochMs('next_attempt_at'),

    createdAt: epochMs('created_at').notNull().default(sql`(extract(epoch from now()) * 1000)::bigint`),
    updatedAt: epochMs('updated_at').notNull().default(sql`(extract(epoch from now()) * 1000)::bigint`),
    submittedAt: epochMs('submitted_at'),
    paidAt: epochMs('paid_at'),
  },
  (t) => [
    uniqueIndex('idx_payouts_transfer').on(t.transferId),
    uniqueIndex('idx_payouts_idempotency').on(t.idempotencyKey),
    index('idx_payouts_status').on(t.status),
    index('idx_payouts_next_attempt').on(t.nextAttemptAt),
    index('idx_payouts_provider_ref').on(t.providerRef),
  ],
)

// ── webhook_events ───────────────────────────────────────────────────────────
// Every provider webhook is recorded before it is acted on, keyed by the
// provider's own event id. Replays — which providers do routinely, and which an
// attacker would attempt deliberately — become no-ops.

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    provider: text('provider').notNull(),
    /** Provider's event id. Unique per provider. */
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payloadDigest: text('payload_digest').notNull(),  // sha256 of the raw body
    processedAt: epochMs('processed_at'),
    error: text('error'),
    createdAt: epochMs('created_at').notNull().default(sql`(extract(epoch from now()) * 1000)::bigint`),
  },
  (t) => [
    uniqueIndex('idx_webhook_provider_event').on(t.provider, t.eventId),
    index('idx_webhook_created').on(t.createdAt),
  ],
)

// ── otp_attempts ─────────────────────────────────────────────────────────────
// Durable per-transfer brute-force guard. Redis provides the fast per-IP check;
// this survives restarts and Redis outages.
//
// The lock is now time-boxed. Previously `locked_at != null` meant locked
// forever with no unlock path, so one mistyped code from a recipient
// permanently stranded their money behind a "contact support" message.

export const otpAttempts = pgTable(
  'otp_attempts',
  {
    transferId: text('transfer_id').primaryKey().references(() => transfers.id, {
      onDelete: 'cascade',
    }),
    attemptCount: integer('attempt_count').notNull().default(0),
    /** Lock expiry (epoch ms). Null = not locked. */
    lockedUntil: epochMs('locked_until'),
    /** Cumulative lockouts; escalates the backoff and flags abuse. */
    lockoutCount: integer('lockout_count').notNull().default(0),
    lastAttemptAt: epochMs('last_attempt_at'),
    lastAttemptIp: text('last_attempt_ip'),
  },
  (t) => [index('idx_otp_locked_until').on(t.lockedUntil)],
)

// ── push_subscriptions ───────────────────────────────────────────────────────

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    userAddress: text('user_address').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: epochMs('created_at').notNull().default(sql`(extract(epoch from now()) * 1000)::bigint`),
  },
  (t) => [
    uniqueIndex('idx_push_endpoint').on(t.endpoint),
    index('idx_push_user').on(t.userAddress),
  ],
)

// ── schedules ────────────────────────────────────────────────────────────────

export const schedules = pgTable(
  'schedules',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    senderAddress: text('sender_address').notNull(),
    recipientPhoneHash: text('recipient_phone_hash'),
    recipientNickname: text('recipient_nickname'),
    amount: text('amount').notNull(),
    corridor: text('corridor').notNull(),
    frequency: text('frequency').notNull(),   // WEEKLY | MONTHLY | CUSTOM
    dayOfMonth: integer('day_of_month'),      // 1–28, for monthly
    nextRunAt: epochMs('next_run_at').notNull(),
    lastRunAt: epochMs('last_run_at'),
    status: text('status').notNull().default('ACTIVE'), // ACTIVE | PAUSED | CANCELLED
    createdAt: epochMs('created_at').notNull().default(sql`(extract(epoch from now()) * 1000)::bigint`),
  },
  (t) => [
    index('idx_schedules_sender').on(t.senderAddress),
    index('idx_schedules_next_run').on(t.nextRunAt),
  ],
)

// ── event_cursor ─────────────────────────────────────────────────────────────
// Singleton row. The event listener resumes from here.

export const eventCursor = pgTable('event_cursor', {
  id: integer('id').primaryKey().default(1),
  lastProcessedBlock: bigint('last_processed_block', { mode: 'number' }).notNull().default(0),
  updatedAt: epochMs('updated_at').notNull().default(sql`(extract(epoch from now()) * 1000)::bigint`),
})

// ── analytics_events ─────────────────────────────────────────────────────────

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    eventName: text('event_name').notNull(),
    walletAddress: text('wallet_address'),
    transferId: text('transfer_id'),
    metadata: text('metadata'),  // JSON string — keep it flat
    createdAt: epochMs('created_at').notNull().default(sql`(extract(epoch from now()) * 1000)::bigint`),
  },
  (t) => [
    index('idx_analytics_event').on(t.eventName),
    index('idx_analytics_created').on(t.createdAt),
  ],
)

// ── Type exports ─────────────────────────────────────────────────────────────

export type Transfer = typeof transfers.$inferSelect
export type NewTransfer = typeof transfers.$inferInsert
export type Payout = typeof payouts.$inferSelect
export type NewPayout = typeof payouts.$inferInsert
export type WebhookEvent = typeof webhookEvents.$inferSelect
export type OtpAttempt = typeof otpAttempts.$inferSelect
export type PushSubscription = typeof pushSubscriptions.$inferSelect
export type Schedule = typeof schedules.$inferSelect
export type NewSchedule = typeof schedules.$inferInsert
export type EventCursor = typeof eventCursor.$inferSelect
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect
