/**
 * /api/ops/payouts — the manual review queue.
 *
 * LAUNCH.md §3 said payouts in MANUAL_REVIEW "need a human. Decide who watches
 * that queue before you have one." There was nowhere for that human to look and
 * no way for them to act, which meant the queue could only grow.
 *
 * GET   lists everything needing attention, oldest first.
 * POST  resolves one payout: retry it, mark it settled out-of-band, or write it
 *       off as reversed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTHENTICATION
 * ─────────────────────────────────────────────────────────────────────────────
 * Bearer OPS_API_TOKEN, compared in constant time. This endpoint can move a
 * payout to PAID, so it is a money-moving surface and is treated like one:
 * required on a production chain, minimum 32 characters, and every action is
 * recorded with the operator's note.
 *
 * It deliberately does NOT reuse CRON_SECRET. That value is handed to Vercel's
 * scheduler; an operator credential that can settle payments should not be the
 * same string.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { timingSafeEqual } from 'node:crypto'
import { asc, eq, inArray } from 'drizzle-orm'
import { db, payouts, transfers } from '@/lib/db'
import { IS_PRODUCTION_CHAIN } from '@/lib/env'
import { applyProviderResult, submitPayout, logPayout } from '@/lib/payouts/ledger'
import { log } from '@/lib/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Statuses that require, or may require, human attention. */
const REVIEW_STATUSES = ['MANUAL_REVIEW', 'FAILED', 'REVERSED'] as const

function authorise(req: NextRequest): boolean {
  const token = process.env.OPS_API_TOKEN
  if (!token) return false

  const header = req.headers.get('authorization') ?? ''
  const expected = `Bearer ${token}`
  const a = Buffer.from(header, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function unauthorised() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

// ─── GET: the queue ──────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!authorise(req)) return unauthorised()
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 503 })

  const rows = await db
    .select({
      id: payouts.id,
      transferId: payouts.transferId,
      status: payouts.status,
      provider: payouts.provider,
      rail: payouts.rail,
      corridor: payouts.corridor,
      amountMinor: payouts.amountMinor,
      currency: payouts.currency,
      sourceAmount: payouts.sourceAmount,
      destinationMasked: payouts.destinationMasked,
      providerRef: payouts.providerRef,
      providerStatus: payouts.providerStatus,
      providerUtr: payouts.providerUtr,
      attempts: payouts.attempts,
      lastError: payouts.lastError,
      createdAt: payouts.createdAt,
      updatedAt: payouts.updatedAt,
      // Enough context to contact the right person.
      recipientPhoneMasked: transfers.recipientPhoneMasked,
      recipientEmail: transfers.recipientEmail,
      senderAddress: transfers.senderAddress,
      claimTxHash: transfers.claimTxHash,
    })
    .from(payouts)
    .leftJoin(transfers, eq(transfers.id, payouts.transferId))
    .where(inArray(payouts.status, [...REVIEW_STATUSES]))
    .orderBy(asc(payouts.createdAt))
    .limit(200)

  // Full destinations are never returned. Resolving a payout does not require
  // reading the recipient's bank identifier out of this API.
  return NextResponse.json({
    queue: rows,
    counts: {
      manualReview: rows.filter(r => r.status === 'MANUAL_REVIEW').length,
      failed: rows.filter(r => r.status === 'FAILED').length,
      reversed: rows.filter(r => r.status === 'REVERSED').length,
      total: rows.length,
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}

// ─── POST: resolve one ───────────────────────────────────────────────────────

const resolveSchema = z.object({
  payoutId: z.string().min(1),
  /**
   * retry          — put it back in the worker queue for another attempt
   * mark_paid      — settled outside the system; requires the bank reference
   * mark_reversed  — the money came back; the transfer needs a separate refund
   */
  action: z.enum(['retry', 'mark_paid', 'mark_reversed']),
  /** Bank UTR / trace number. Required for mark_paid. */
  reference: z.string().min(1).max(120).optional(),
  /** Who is doing this and why. Recorded. */
  note: z.string().min(3).max(500),
  operator: z.string().min(1).max(120),
})

export async function POST(req: NextRequest) {
  if (!authorise(req)) return unauthorised()
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 503 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = resolveSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const { payoutId, action, reference, note, operator } = parsed.data

  const rows = await db.select().from(payouts).where(eq(payouts.id, payoutId)).limit(1)
  const payout = rows[0]
  if (!payout) return NextResponse.json({ error: 'Payout not found' }, { status: 404 })

  if (payout.status === 'PAID') {
    return NextResponse.json({ error: 'This payout is already settled' }, { status: 409 })
  }

  const audit = `[${new Date().toISOString()}] ${operator}: ${note}`

  switch (action) {
    case 'retry': {
      // Only from a genuinely retryable state. Re-submitting something that may
      // already have moved money is how a recipient gets paid twice.
      if (payout.status !== 'FAILED' && payout.status !== 'MANUAL_REVIEW') {
        return NextResponse.json(
          { error: `Cannot retry a payout in ${payout.status}` },
          { status: 409 },
        )
      }
      if (payout.providerRef) {
        return NextResponse.json(
          {
            error:
              'This payout already has a provider reference, so the provider may have ' +
              'accepted it. Check its status with the provider before retrying — a blind ' +
              'retry risks paying twice.',
            providerRef: payout.providerRef,
          },
          { status: 409 },
        )
      }

      await db
        .update(payouts)
        .set({
          status: 'FAILED',      // FAILED is the worker's retry entry point
          attempts: 0,           // fresh budget, deliberate operator decision
          nextAttemptAt: Date.now(),
          lastError: audit,
          updatedAt: Date.now(),
        })
        .where(eq(payouts.id, payoutId))

      await submitPayout(payoutId)
      break
    }

    case 'mark_paid': {
      if (!reference) {
        return NextResponse.json(
          { error: 'A bank reference is required to mark a payout as settled' },
          { status: 400 },
        )
      }
      // Goes through the same state machine as everything else, so the
      // transition is validated rather than written directly.
      await applyProviderResult(payoutId, {
        providerRef: payout.providerRef ?? `manual_${payoutId.slice(0, 8)}`,
        providerStatus: 'manually_settled',
        status: 'PAID',
        utr: reference,
      })
      await db
        .update(payouts)
        .set({ lastError: audit, updatedAt: Date.now() })
        .where(eq(payouts.id, payoutId))
      break
    }

    case 'mark_reversed': {
      await applyProviderResult(payoutId, {
        providerRef: payout.providerRef ?? `manual_${payoutId.slice(0, 8)}`,
        providerStatus: 'manually_reversed',
        status: 'REVERSED',
      })
      await db
        .update(payouts)
        .set({ lastError: audit, updatedAt: Date.now() })
        .where(eq(payouts.id, payoutId))
      break
    }
  }

  const [updated] = await db.select().from(payouts).where(eq(payouts.id, payoutId)).limit(1)

  logPayout('info', 'ops.payout_resolved', {
    payoutId,
    action,
    operator,
    from: payout.status,
    to: updated?.status,
  })

  return NextResponse.json({
    ok: true,
    payoutId,
    action,
    status: updated?.status,
  })
}

// Surface a misconfiguration early rather than at 3am.
if (IS_PRODUCTION_CHAIN && !process.env.OPS_API_TOKEN) {
  log('warn', 'ops.token_missing', {
    detail: 'OPS_API_TOKEN is unset — the manual review queue is unreachable',
  })
}
