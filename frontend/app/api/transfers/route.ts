/**
 * app/api/transfers/route.ts
 * GET /api/transfers?address=0x...
 *
 * Returns a sender's transfer history from DB, limit 50 most recent.
 * Off-chain metadata (nickname, SMS status, offramp status) comes from DB.
 * On-chain authoritative status is NOT re-fetched here — that's the live
 * tracker's job. This endpoint serves the dashboard history list.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq, desc } from 'drizzle-orm'
import { db, transfers } from '@/lib/db'

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid address')

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const rawAddress = req.nextUrl.searchParams.get('address')

  if (!rawAddress) {
    return NextResponse.json({ transfers: [] })
  }

  const parsed = addressSchema.safeParse(rawAddress)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  const address = parsed.data.toLowerCase()

  if (!db) {
    return NextResponse.json({
      transfers: [],
      warning: 'Database not configured — add DATABASE_URL to .env',
    })
  }

  const rows = await db
    .select({
      id: transfers.id,
      txHash: transfers.txHash,
      recipientNickname: transfers.recipientNickname,
      recipientPhoneHash: transfers.recipientPhoneHash,
      amount: transfers.amount,
      corridor: transfers.corridor,
      status: transfers.status,
      offrampStatus: transfers.offrampStatus,
      offrampMethod: transfers.offrampMethod,
      smsStatus: transfers.smsStatus,
      createdAt: transfers.createdAt,
      claimedAt: transfers.claimedAt,
      expiry: transfers.expiry,
    })
    .from(transfers)
    .where(eq(transfers.senderAddress, address))
    .orderBy(desc(transfers.createdAt))
    .limit(50)

  return NextResponse.json({ transfers: rows })
}
