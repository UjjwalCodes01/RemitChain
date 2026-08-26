/**
 * POST /api/webhooks/razorpay
 *
 * Authoritative settlement signal from RazorpayX.
 *
 * Three properties this endpoint must have, all of which the previous build
 * lacked entirely (there was no webhook receiver at all — payouts were assumed
 * to have succeeded the moment the API call returned):
 *
 *   1. AUTHENTICATED. The HMAC is computed over the raw request bytes. Anyone
 *      can POST here; only Razorpay can sign.
 *   2. IDEMPOTENT. Providers retry deliveries, and an attacker who captures one
 *      would replay it. Every event is recorded by its provider event id and a
 *      duplicate is a no-op.
 *   3. MONOTONIC. Applying an event can only move a payout forward through the
 *      state machine. A late `payout.processing` cannot un-pay a PAID payout.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, webhookEvents } from '@/lib/db'
import { razorpayProvider } from '@/lib/payouts/providers/razorpay'
import { applyProviderResult, getPayoutByProviderRef, logPayout } from '@/lib/payouts/ledger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Razorpay retries on timeout, so keep this short and let it redeliver.
export const maxDuration = 20

export async function POST(req: NextRequest) {
  // The signature covers the exact bytes received. Reading the body as text and
  // never re-serialising it is essential — JSON.parse followed by
  // JSON.stringify would reorder keys and invalidate the HMAC.
  const rawBody = await req.text()

  const verification = razorpayProvider.verifyWebhook(rawBody, req.headers)

  if (!verification.ok) {
    logPayout('warn', 'webhook.rejected', { provider: 'razorpay', reason: verification.error })
    // 401 rather than 400: this is an authentication failure, and Razorpay
    // treats 4xx as "do not retry", which is correct for a bad signature.
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const eventId = verification.eventId ?? createHash('sha256').update(rawBody).digest('hex').slice(0, 32)
  const eventType = verification.eventType ?? 'unknown'
  const digest = createHash('sha256').update(rawBody).digest('hex')

  if (!db) {
    // Without the ledger there is nothing to update. Return 200 so Razorpay
    // stops retrying — the reconciler will pick the payout up from the
    // provider's own state once the database is back.
    logPayout('error', 'webhook.no_database', { eventType })
    return NextResponse.json({ received: true, applied: false })
  }

  // ── Idempotency ───────────────────────────────────────────────────────────
  const inserted = await db
    .insert(webhookEvents)
    .values({
      provider: 'razorpay',
      eventId,
      eventType,
      payloadDigest: digest,
      createdAt: Date.now(),
    })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.eventId] })
    .returning({ id: webhookEvents.id })

  if (inserted.length === 0) {
    logPayout('info', 'webhook.duplicate', { eventType, eventId })
    return NextResponse.json({ received: true, duplicate: true })
  }

  const recordId = inserted[0].id

  // ── Apply ─────────────────────────────────────────────────────────────────
  try {
    if (!verification.providerRef || !verification.status) {
      // A verified event we have no rule for (transaction events, account
      // events). Recorded above, nothing to do.
      await markProcessed(recordId, null)
      return NextResponse.json({ received: true, applied: false, reason: 'Not a payout event' })
    }

    const payout = await getPayoutByProviderRef('razorpay', verification.providerRef)
    if (!payout) {
      // Razorpay knows about a payout we have no record of. That should be
      // impossible and is worth alerting on, but returning 200 stops a retry
      // storm over something a retry cannot fix.
      logPayout('error', 'webhook.unknown_payout', {
        providerRef: verification.providerRef,
        eventType,
      })
      await markProcessed(recordId, 'No matching payout in the ledger')
      return NextResponse.json({ received: true, applied: false })
    }

    await applyProviderResult(payout.id, {
      providerRef: verification.providerRef,
      providerStatus: verification.providerStatus ?? eventType,
      status: verification.status,
      utr: verification.utr,
    })

    await markProcessed(recordId, null)

    logPayout('info', 'webhook.applied', {
      payoutId: payout.id,
      eventType,
      status: verification.status,
    })

    return NextResponse.json({ received: true, applied: true })
  } catch (err) {
    const message = String(err).slice(0, 400)
    await markProcessed(recordId, message)
    logPayout('error', 'webhook.apply_failed', { eventType, err: message })
    // 500 asks Razorpay to redeliver. The unique index makes the retry safe.
    return NextResponse.json({ error: 'Failed to process event' }, { status: 500 })
  }
}

async function markProcessed(id: string, error: string | null) {
  if (!db) return
  await db
    .update(webhookEvents)
    .set({ processedAt: Date.now(), error })
    .where(eq(webhookEvents.id, id))
}
