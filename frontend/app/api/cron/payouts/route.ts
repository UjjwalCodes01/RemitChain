/**
 * GET /api/cron/payouts
 *
 * The reliability guarantee behind every payout.
 *
 * Three jobs, in order:
 *   1. REPAIR   — transfers that settled on-chain but have no payout row.
 *                 This is the one failure mode the claim route deliberately
 *                 allows (crash between broadcast and enqueue), so something
 *                 has to close it.
 *   2. SUBMIT   — payouts in CREATED or FAILED whose backoff has elapsed.
 *   3. RECONCILE— payouts in flight, polled against the provider in case a
 *                 webhook was dropped, and escalated to MANUAL_REVIEW if they
 *                 have been stuck too long.
 *
 * Authenticated with CRON_SECRET, with no origin-based bypass.
 */

import { NextRequest, NextResponse } from 'next/server'
import { IS_PRODUCTION_CHAIN } from '@/lib/env'
import {
  findOrphanedClaims,
  repairOrphanedClaim,
  runPayoutReconciler,
  runPayoutWorker,
} from '@/lib/payouts/ledger'
import { authenticateCron, log } from '@/lib/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const auth = authenticateCron(req)
  if (!auth.ok) {
    log('warn', 'cron.payouts_unauthorized', { reason: auth.reason })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  const report = {
    orphansFound: 0,
    repaired: 0,
    needsHuman: 0,
    submitted: 0,
    reconciled: 0,
    escalated: 0,
  }

  try {
    // ── 1. Repair orphaned claims ──────────────────────────────────────────
    const orphans = await findOrphanedClaims(20)
    report.orphansFound = orphans.length

    for (const orphan of orphans) {
      // The destination was recorded before the claim was broadcast, so most
      // orphans repair themselves here with no human involved.
      const outcome = await repairOrphanedClaim(orphan, IS_PRODUCTION_CHAIN)
      if (outcome === 'repaired') report.repaired++
      else report.needsHuman++
    }

    // ── 2. Submit due payouts ──────────────────────────────────────────────
    report.submitted = await runPayoutWorker(25)

    // ── 3. Reconcile in-flight payouts ─────────────────────────────────────
    const reconcileResult = await runPayoutReconciler(25)
    report.reconciled = reconcileResult.reconciled
    report.escalated = reconcileResult.escalated

    log('info', 'cron.payouts', { ...report, durationMs: Date.now() - started })

    return NextResponse.json({ ok: true, ...report, durationMs: Date.now() - started })
  } catch (err) {
    log('error', 'cron.payouts_failed', { err: String(err).slice(0, 400), ...report })
    return NextResponse.json({ ok: false, error: 'Payout run failed', ...report }, { status: 500 })
  }
}

// Vercel Cron issues GET; POST is here so the job can be triggered manually
// with the same credentials during an incident.
export const POST = GET
