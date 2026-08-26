/**
 * GET /api/transfers?address=0x…
 *
 * A sender's own transfer history, 50 most recent.
 *
 * The `?address=all&demo=true` "god view", which returned every transfer
 * across all senders, has been removed. It was gated only on a `DEMO_MODE`
 * environment variable — a single misconfigured deploy would have exposed
 * every user's transfer history, phone-number commitments included.
 *
 * There is no supported way to list other people's transfers through this API.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq, desc } from 'drizzle-orm'
import { db, transfers, payouts } from '@/lib/db'
import { rateLimit } from '@/lib/ratelimit'
import { clientIp } from '@/lib/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid address')

export async function GET(req: NextRequest) {
  const rawAddress = req.nextUrl.searchParams.get('address')
  if (!rawAddress) return NextResponse.json({ transfers: [] })

  const parsed = addressSchema.safeParse(rawAddress)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  const limited = await rateLimit('transfers:list', clientIp(req), { limit: 120, windowSeconds: 60 })
  if (!limited.success) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  if (!db) {
    return NextResponse.json({ transfers: [], warning: 'History is temporarily unavailable' })
  }

  const address = parsed.data.toLowerCase()

  const rows = await db
    .select({
      id: transfers.id,
      txHash: transfers.txHash,
      claimTxHash: transfers.claimTxHash,
      recipientNickname: transfers.recipientNickname,
      recipientPhoneMasked: transfers.recipientPhoneMasked,
      amount: transfers.amount,
      netAmount: transfers.netAmount,
      corridor: transfers.corridor,
      status: transfers.status,
      notifyStatus: transfers.notifyStatus,
      quotedRate: transfers.quotedRate,
      quotedCurrency: transfers.quotedCurrency,
      quotedLocalMinor: transfers.quotedLocalMinor,
      createdAt: transfers.createdAt,
      claimedAt: transfers.claimedAt,
      expiry: transfers.expiry,
      payoutStatus: payouts.status,
      payoutRail: payouts.rail,
      payoutDestinationMasked: payouts.destinationMasked,
      payoutUtr: payouts.providerUtr,
    })
    .from(transfers)
    .leftJoin(payouts, eq(payouts.transferId, transfers.id))
    .where(eq(transfers.senderAddress, address))
    .orderBy(desc(transfers.createdAt))
    .limit(50)

  return NextResponse.json({ transfers: rows }, { headers: { 'Cache-Control': 'no-store' } })
}
