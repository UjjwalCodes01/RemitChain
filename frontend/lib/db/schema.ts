/**
 * lib/db/schema.ts
 *
 * Drizzle ORM schema for RemitChain Postgres (Neon serverless).
 *
 * Convention:
 *   - transferId = bytes32 hex string (0x...) stored as text (primary key)
 *   - amounts    = text (bigint serialised — Postgres bigint loses precision in JS)
 *   - timestamps = integer (unix ms) for cheap indexing; updatedAt auto-set by trigger
 */

import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// ── transfers ────────────────────────────────────────────────────────────────
// Mirror of on-chain transfer struct + off-chain metadata (offramp, SMS, nickname).
// Source of money truth is always the contract — this table is the metadata layer.

export const transfers = pgTable(
  'transfers',
  {
    // On-chain identity
    id: text('id').primaryKey(), // transferId (bytes32 hex)
    txHash: text('tx_hash'),     // sendRemittance() tx hash
    senderAddress: text('sender_address').notNull(),
    recipientPhoneHash: text('recipient_phone_hash').notNull(),

    // Off-chain metadata (sender provides at send time)
    recipientNickname: text('recipient_nickname'), // e.g. "Mom" — never hits chain

    // Financial
    amount: text('amount').notNull(),              // QUSD base units as string (bigint)
    corridor: text('corridor').notNull(),

    // On-chain status (synced by event listener)
    // 0=PENDING 1=CLAIMED 2=CANCELLED
    status: integer('status').notNull().default(0),

    // Off-ramp (happens after claim)
    offrampStatus: text('offramp_status').notNull().default('NONE'),
    // NONE | PENDING | COMPLETED | FAILED
    offrampMethod: text('offramp_method'),      // UPI | GCASH | AGENT | null
    offrampReference: text('offramp_reference'), // payout provider txn id

    // SMS delivery
    smsStatus: text('sms_status').notNull().default('PENDING'),
    // PENDING | SENT | FAILED

    // Timestamps
    createdAt: integer('created_at').notNull().default(sql`extract(epoch from now()) * 1000`),
    updatedAt: integer('updated_at').notNull().default(sql`extract(epoch from now()) * 1000`),
    claimedAt: integer('claimed_at'),
    expiry: integer('expiry'),                   // mirrors on-chain expiry (unix s)
  },
  (t) => [
    index('idx_transfers_sender').on(t.senderAddress),
    index('idx_transfers_status').on(t.status),
    index('idx_transfers_created').on(t.createdAt),
  ],
)

// ── otp_attempts ─────────────────────────────────────────────────────────────
// DB-backed rate limiting. 3 failures per transferId → permanent lock (cleared on success).
// Redis provides the fast per-IP per-hour check; this is the durable per-transferId lock.

export const otpAttempts = pgTable(
  'otp_attempts',
  {
    transferId: text('transfer_id').primaryKey().references(() => transfers.id, {
      onDelete: 'cascade',
    }),
    attemptCount: integer('attempt_count').notNull().default(0),
    lockedAt: integer('locked_at'),              // unix ms — null = not locked
    lastAttemptAt: integer('last_attempt_at'),
    lastAttemptIp: text('last_attempt_ip'),
  },
)

// ── push_subscriptions ───────────────────────────────────────────────────────
// Web Push subscriptions, replacing the in-memory Map.

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    userAddress: text('user_address').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: integer('created_at').notNull().default(sql`extract(epoch from now()) * 1000`),
  },
  (t) => [
    uniqueIndex('idx_push_endpoint').on(t.endpoint),
    index('idx_push_user').on(t.userAddress),
  ],
)

// ── schedules ────────────────────────────────────────────────────────────────
// Recurring transfers, replacing the in-memory Map.

export const schedules = pgTable(
  'schedules',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    senderAddress: text('sender_address').notNull(),
    recipientPhoneHash: text('recipient_phone_hash'), // nullable — set at send time
    recipientNickname: text('recipient_nickname'),
    amount: text('amount').notNull(), // stringified number for precision
    corridor: text('corridor').notNull(),
    frequency: text('frequency').notNull(), // WEEKLY | MONTHLY | CUSTOM
    dayOfMonth: integer('day_of_month'),    // 1–28, for monthly
    nextRunAt: integer('next_run_at').notNull(), // unix ms
    lastRunAt: integer('last_run_at'),
    status: text('status').notNull().default('ACTIVE'), // ACTIVE | PAUSED | CANCELLED
    createdAt: integer('created_at').notNull().default(sql`extract(epoch from now()) * 1000`),
  },
  (t) => [
    index('idx_schedules_sender').on(t.senderAddress),
    index('idx_schedules_next_run').on(t.nextRunAt),
  ],
)

// ── event_cursor ─────────────────────────────────────────────────────────────
// Singleton row. The event listener reads this to know where to resume.
// CRITICAL: if this row is missing, listener starts from current block.

export const eventCursor = pgTable('event_cursor', {
  id: integer('id').primaryKey().default(1), // always 1 — singleton
  lastProcessedBlock: bigint('last_processed_block', { mode: 'number' }).notNull().default(0),
  updatedAt: integer('updated_at').notNull().default(sql`extract(epoch from now()) * 1000`),
})

// ── analytics_events ─────────────────────────────────────────────────────────
// Lightweight funnel event log. Fire-and-forget from frontend.
// Events: wallet_connected, transfer_sent, transfer_claimed,
//         offramp_completed, faucet_dripped, claim_failed

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    eventName: text('event_name').notNull(),
    walletAddress: text('wallet_address'),
    transferId: text('transfer_id'),
    metadata: text('metadata'), // JSON string — keep it flat
    createdAt: integer('created_at').notNull().default(sql`extract(epoch from now()) * 1000`),
  },
  (t) => [
    index('idx_analytics_event').on(t.eventName),
    index('idx_analytics_created').on(t.createdAt),
  ],
)

// ── Type exports ─────────────────────────────────────────────────────────────

export type Transfer = typeof transfers.$inferSelect
export type NewTransfer = typeof transfers.$inferInsert
export type OtpAttempt = typeof otpAttempts.$inferSelect
export type PushSubscription = typeof pushSubscriptions.$inferSelect
export type Schedule = typeof schedules.$inferSelect
export type NewSchedule = typeof schedules.$inferInsert
export type EventCursor = typeof eventCursor.$inferSelect
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect
