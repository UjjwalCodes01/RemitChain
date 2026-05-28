/**
 * app/api/analytics/route.ts
 * POST /api/analytics  { event, address?, transferId?, metadata? }
 *
 * Fire-and-forget lightweight event tracking.
 * Always returns 200 so client never blocks on this.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db, analyticsEvents } from '@/lib/db'

const VALID_EVENTS = [
  'wallet_connected', 'transfer_sent', 'transfer_claimed',
  'offramp_completed', 'faucet_dripped', 'claim_failed',
  'page_view', 'onboarding_completed',
] as const

const schema = z.object({
  event: z.string().min(1).max(64),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  transferId: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  metadata: z.record(z.unknown()).optional(),
})

export async function POST(req: NextRequest) {
  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ ok: true }) } // always succeed

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ ok: true })

  const { event, address, transferId, metadata } = parsed.data

  if (db) {
    // Insert async, don't await — caller doesn't need to wait
    db.insert(analyticsEvents).values({
      eventName: event,
      walletAddress: address?.toLowerCase() ?? null,
      transferId: transferId ?? null,
      metadata: metadata ? JSON.stringify(metadata) : null,
      createdAt: Date.now(),
    }).catch(err => console.warn('[analytics] Insert failed (non-fatal):', err))
  }

  // Structured log regardless (Vercel log drain picks this up)
  console.log(JSON.stringify({
    level: 'info', step: 'analytics.event',
    event, ts: new Date().toISOString(),
    ...(address ? { address: address.slice(0, 10) + '…' } : {}),
  }))

  return NextResponse.json({ ok: true })
}
