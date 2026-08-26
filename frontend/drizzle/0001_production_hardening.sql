-- ═══════════════════════════════════════════════════════════════════════════
-- 0001_production_hardening
--
-- Brings an existing 0000 database up to the production schema.
--
-- Written by hand rather than generated, because it has to do three things a
-- generated diff cannot:
--   1. widen every timestamp column from int4 to int8 WITHOUT losing rows
--   2. rescale the timestamp values that were written in seconds into the
--      milliseconds the column now claims to hold
--   3. lift the inline off-ramp columns on `transfers` into the new `payouts`
--      ledger before dropping them
--
-- Every statement is idempotent, so re-running the migration is safe.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── transfers: widen timestamps ────────────────────────────────────────────
ALTER TABLE "transfers" ALTER COLUMN "created_at" TYPE bigint;--> statement-breakpoint
ALTER TABLE "transfers" ALTER COLUMN "updated_at" TYPE bigint;--> statement-breakpoint
ALTER TABLE "transfers" ALTER COLUMN "claimed_at" TYPE bigint;--> statement-breakpoint
ALTER TABLE "transfers" ALTER COLUMN "expiry"     TYPE bigint;--> statement-breakpoint

ALTER TABLE "transfers" ALTER COLUMN "created_at" SET DEFAULT (extract(epoch from now()) * 1000)::bigint;--> statement-breakpoint
ALTER TABLE "transfers" ALTER COLUMN "updated_at" SET DEFAULT (extract(epoch from now()) * 1000)::bigint;--> statement-breakpoint

-- Rescale seconds → milliseconds.
-- 1e11 ms is 1973; 1e11 s is the year 5138. Any value below the threshold is
-- unambiguously a seconds value written by the old code paths.
UPDATE "transfers" SET "created_at" = "created_at" * 1000 WHERE "created_at" > 0     AND "created_at" < 100000000000;--> statement-breakpoint
UPDATE "transfers" SET "updated_at" = "updated_at" * 1000 WHERE "updated_at" > 0     AND "updated_at" < 100000000000;--> statement-breakpoint
UPDATE "transfers" SET "claimed_at" = "claimed_at" * 1000 WHERE "claimed_at" > 0     AND "claimed_at" < 100000000000;--> statement-breakpoint
-- `expiry` mirrors the on-chain uint64, which is in seconds. It is now stored
-- in ms like every other timestamp.
UPDATE "transfers" SET "expiry"     = "expiry"     * 1000 WHERE "expiry"     > 0     AND "expiry"     < 100000000000;--> statement-breakpoint

-- ── transfers: new columns ─────────────────────────────────────────────────
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "claim_tx_hash"          text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "sender_nonce"           bigint;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "recipient_phone_masked" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "recipient_email"        text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "fee_amount"             text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "net_amount"             text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "quoted_rate"            text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "quoted_currency"        text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "quoted_local_minor"     text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "quoted_at"              bigint;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "claim_secret_enc"       text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "otp_enc"                text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "notify_channel"         text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "notify_status"          text NOT NULL DEFAULT 'PENDING';--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "notify_attempts"        integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "notify_last_error"      text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "cancelled_at"           bigint;--> statement-breakpoint

-- Carry the old delivery status forward. `email_status` was added out-of-band
-- by scripts/fix-db-schema.ts and may not exist, hence the guard.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'transfers' AND column_name = 'email_status') THEN
    EXECUTE 'UPDATE "transfers" SET "notify_status" = "email_status"
             WHERE "email_status" IS NOT NULL AND "notify_status" = ''PENDING''';
  ELSIF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'transfers' AND column_name = 'sms_status') THEN
    EXECUTE 'UPDATE "transfers" SET "notify_status" = "sms_status"
             WHERE "sms_status" IS NOT NULL AND "notify_status" = ''PENDING''';
  END IF;
END $$;--> statement-breakpoint

-- Backfill the fee split for historical rows using the 0.1% launch fee.
UPDATE "transfers"
   SET "fee_amount" = (("amount")::numeric * 10 / 10000)::bigint::text,
       "net_amount" = (("amount")::numeric - (("amount")::numeric * 10 / 10000)::bigint)::bigint::text
 WHERE "net_amount" IS NULL
   AND "amount" ~ '^[0-9]+$';--> statement-breakpoint

-- ── payouts ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payouts" (
  "id"                 text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transfer_id"        text NOT NULL,
  "provider"           text NOT NULL,
  "corridor"           text NOT NULL,
  "rail"               text NOT NULL,
  "destination"        text NOT NULL,
  "destination_masked" text NOT NULL,
  "amount_minor"       text NOT NULL,
  "currency"           text NOT NULL,
  "source_amount"      text NOT NULL,
  "fx_rate"            text NOT NULL,
  "fx_source"          text NOT NULL,
  "status"             text NOT NULL DEFAULT 'CREATED',
  "idempotency_key"    text NOT NULL,
  "provider_ref"       text,
  "provider_account_ref" text,
  "provider_status"    text,
  "provider_utr"       text,
  "attempts"           integer NOT NULL DEFAULT 0,
  "last_error"         text,
  "next_attempt_at"    bigint,
  "created_at"         bigint NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
  "updated_at"         bigint NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
  "submitted_at"       bigint,
  "paid_at"            bigint
);--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payouts_transfer_id_transfers_id_fk') THEN
    ALTER TABLE "payouts" ADD CONSTRAINT "payouts_transfer_id_transfers_id_fk"
      FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_payouts_transfer"     ON "payouts" USING btree ("transfer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_payouts_idempotency"  ON "payouts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payouts_status"              ON "payouts" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payouts_next_attempt"        ON "payouts" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payouts_provider_ref"        ON "payouts" USING btree ("provider_ref");--> statement-breakpoint

-- Lift historical off-ramp records into the ledger so the payout history is
-- continuous across the upgrade. These land as MANUAL_REVIEW rather than PAID:
-- the old code marked stubbed corridors 'COMPLETED' without moving money, so
-- their true state is unknown and a human has to confirm each one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'transfers' AND column_name = 'offramp_status') THEN
    EXECUTE $sql$
      INSERT INTO "payouts" (
        "transfer_id", "provider", "corridor", "rail",
        "destination", "destination_masked",
        "amount_minor", "currency", "source_amount",
        "fx_rate", "fx_source", "status",
        "idempotency_key", "provider_ref", "provider_status",
        "created_at", "updated_at"
      )
      SELECT
        t."id",
        'legacy',
        t."corridor",
        COALESCE(t."offramp_method", 'UNKNOWN'),
        '', '',
        '0',
        'USD',
        COALESCE(t."net_amount", t."amount"),
        '0', 'legacy',
        CASE WHEN t."offramp_status" = 'FAILED' THEN 'FAILED' ELSE 'MANUAL_REVIEW' END,
        'legacy:' || t."id",
        t."offramp_reference",
        t."offramp_status",
        COALESCE(t."claimed_at", t."created_at"),
        COALESCE(t."claimed_at", t."created_at")
      FROM "transfers" t
      WHERE t."offramp_status" IS NOT NULL
        AND t."offramp_status" <> 'NONE'
      ON CONFLICT ("transfer_id") DO NOTHING
    $sql$;
  END IF;
END $$;--> statement-breakpoint

-- Now that they are preserved in the ledger, retire the inline columns.
ALTER TABLE "transfers" DROP COLUMN IF EXISTS "offramp_status";--> statement-breakpoint
ALTER TABLE "transfers" DROP COLUMN IF EXISTS "offramp_method";--> statement-breakpoint
ALTER TABLE "transfers" DROP COLUMN IF EXISTS "offramp_reference";--> statement-breakpoint
ALTER TABLE "transfers" DROP COLUMN IF EXISTS "sms_status";--> statement-breakpoint
ALTER TABLE "transfers" DROP COLUMN IF EXISTS "email_status";--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_transfers_phone_hash" ON "transfers" USING btree ("recipient_phone_hash");--> statement-breakpoint

-- ── webhook_events ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id"             text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider"       text NOT NULL,
  "event_id"       text NOT NULL,
  "event_type"     text NOT NULL,
  "payload_digest" text NOT NULL,
  "processed_at"   bigint,
  "error"          text,
  "created_at"     bigint NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_webhook_provider_event" ON "webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_created"               ON "webhook_events" USING btree ("created_at");--> statement-breakpoint

-- ── otp_attempts: time-boxed locks ─────────────────────────────────────────
ALTER TABLE "otp_attempts" ALTER COLUMN "last_attempt_at" TYPE bigint;--> statement-breakpoint
ALTER TABLE "otp_attempts" ADD COLUMN IF NOT EXISTS "locked_until" bigint;--> statement-breakpoint
ALTER TABLE "otp_attempts" ADD COLUMN IF NOT EXISTS "lockout_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint

-- Convert the old permanent lock into a bounded one, and release anyone who is
-- currently stuck behind it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'otp_attempts' AND column_name = 'locked_at') THEN
    EXECUTE 'UPDATE "otp_attempts" SET "lockout_count" = 1 WHERE "locked_at" IS NOT NULL';
    EXECUTE 'ALTER TABLE "otp_attempts" DROP COLUMN "locked_at"';
  END IF;
END $$;--> statement-breakpoint

UPDATE "otp_attempts" SET "attempt_count" = 0, "locked_until" = NULL WHERE "locked_until" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_otp_locked_until" ON "otp_attempts" USING btree ("locked_until");--> statement-breakpoint

-- ── remaining timestamp widenings ──────────────────────────────────────────
ALTER TABLE "push_subscriptions" ALTER COLUMN "created_at" TYPE bigint;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ALTER COLUMN "created_at" SET DEFAULT (extract(epoch from now()) * 1000)::bigint;--> statement-breakpoint

ALTER TABLE "schedules" ALTER COLUMN "next_run_at" TYPE bigint;--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "last_run_at" TYPE bigint;--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "created_at"  TYPE bigint;--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "created_at"  SET DEFAULT (extract(epoch from now()) * 1000)::bigint;--> statement-breakpoint

ALTER TABLE "analytics_events" ALTER COLUMN "created_at" TYPE bigint;--> statement-breakpoint
ALTER TABLE "analytics_events" ALTER COLUMN "created_at" SET DEFAULT (extract(epoch from now()) * 1000)::bigint;--> statement-breakpoint

ALTER TABLE "event_cursor" ALTER COLUMN "updated_at" TYPE bigint;--> statement-breakpoint
ALTER TABLE "event_cursor" ALTER COLUMN "updated_at" SET DEFAULT (extract(epoch from now()) * 1000)::bigint;--> statement-breakpoint
UPDATE "event_cursor" SET "updated_at" = "updated_at" * 1000 WHERE "updated_at" > 0 AND "updated_at" < 100000000000;
