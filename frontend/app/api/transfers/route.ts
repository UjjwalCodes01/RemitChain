/**
 * app/api/transfers/route.ts
 * GET /api/transfers?address=0x...
 *
 * Returns a sender's transfer history from DB, limit 50 most recent.
 * Off-chain metadata (nickname, SMS status, offramp status) comes from DB.
 * On-chain authoritative status is NOT re-fetched here — that's the live
 * tracker's job. This endpoint serves the dashboard history list.
 *
 * DEMO MODE EXTENSION:
 * GET /api/transfers?address=all&demo=true
 * Returns the 20 most recent transfers across ALL senders.
 * Hard-gated behind DEMO_MODE env var — returns 403 in production.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq, desc } from 'drizzle-orm'
import { db, transfers } from '@/lib/db'
import { env } from '@/lib/env'

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid address')

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const rawAddress = req.nextUrl.searchParams.get('address')
  const isAllDemo = rawAddress === 'all' && req.nextUrl.searchParams.get('demo') === 'true'

  // Demo Mode: all-transfers god view
  if (isAllDemo) {
    if (!env.DEMO_MODE) {
      return NextResponse.json({ error: 'Demo Mode is not enabled' }, { status: 403 })
    }
    if (!db) {
      return NextResponse.json({ transfers: [], warning: 'Database not configured' })
    }

    const selectedFields = {
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
    }

    const rows = await db
      .select(selectedFields)
      .from(transfers)
      .orderBy(desc(transfers.createdAt))
      .limit(20)

    return NextResponse.json({ transfers: rows })
  }

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
