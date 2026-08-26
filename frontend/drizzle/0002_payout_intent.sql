-- ═══════════════════════════════════════════════════════════════════════════
-- 0002_payout_intent
--
-- Makes an orphaned claim recoverable.
--
-- The claim route broadcasts `claimRemittance`, waits for the receipt, and only
-- then writes the payout row — deliberately, so fiat can never leave against an
-- escrow that did not release.
--
-- The gap that leaves: if the serverless function is killed between the
-- broadcast and the enqueue (a Vercel timeout is the realistic cause — waiting
-- on a receipt is the slowest step in the request), the escrow has released and
-- nobody has a record of where the recipient wanted the money. Their funds are
-- out of escrow and unroutable, and the only fix is to contact them and ask
-- again.
--
-- Recording the destination BEFORE broadcasting closes it. The payout cron can
-- then repair the orphan automatically, with no human involved and no risk of
-- paying early — a payout is still only created once the chain confirms the
-- claim.
--
-- Stored encrypted (AES-256-GCM, SECRETS_ENCRYPTION_KEY): a UPI ID or bank
-- account number is exactly the kind of value that should not sit in plaintext.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "payout_destination_enc" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "payout_intent_at" bigint;
