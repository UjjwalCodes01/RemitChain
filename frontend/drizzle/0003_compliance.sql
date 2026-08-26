-- ═══════════════════════════════════════════════════════════════════════════
-- 0003_compliance
--
-- Sanctions / PEP screening records and the local denylist.
--
-- Screening decisions have to be RECORDED, not just made. A regulator asking
-- "why did you let this transfer through" needs an answer with a timestamp, a
-- provider, and the match detail the decision was based on. Deciding in memory
-- and forgetting is the same as not screening.
--
-- Personally identifying values are stored as keyed hashes, never plaintext:
-- the denylist holds a hash of the phone number or address, so a database
-- compromise does not hand over a list of screened individuals.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "screening_records" (
  "id"           text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Null when screening happened before a transfer id existed.
  "transfer_id"  text,
  -- 'sender' | 'recipient'
  "subject_type" text NOT NULL,
  -- Keyed hash of the address or phone number. Never the raw value.
  "subject_hash" text NOT NULL,
  -- Masked form, safe to show a compliance officer.
  "subject_masked" text,
  -- 'ALLOW' | 'REVIEW' | 'BLOCK'
  "decision"     text NOT NULL,
  "provider"     text NOT NULL,
  -- Provider's rationale. JSON string, no raw PII.
  "match_detail" text,
  "corridor"     text,
  "amount"       text,
  "created_at"   bigint NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_screening_transfer"  ON "screening_records" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_screening_subject"   ON "screening_records" USING btree ("subject_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_screening_decision"  ON "screening_records" USING btree ("decision");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_screening_created"   ON "screening_records" USING btree ("created_at");--> statement-breakpoint

-- ── Denylist ───────────────────────────────────────────────────────────────
-- Operator-maintained. Entries are matched by keyed hash, so adding someone
-- does not require storing who they are.

CREATE TABLE IF NOT EXISTS "screening_denylist" (
  "id"          text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- 'address' | 'phone'
  "kind"        text NOT NULL,
  "value_hash"  text NOT NULL,
  "value_masked" text,
  "reason"      text NOT NULL,
  "added_by"    text,
  "active"      boolean NOT NULL DEFAULT true,
  "created_at"  bigint NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_denylist_value" ON "screening_denylist" USING btree ("kind","value_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_denylist_active" ON "screening_denylist" USING btree ("active");
