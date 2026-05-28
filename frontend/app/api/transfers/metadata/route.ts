/**
 * app/api/transfers/metadata/route.ts
 * POST /api/transfers/metadata
 *
 * Called by the frontend immediately after a transfer tx is confirmed.
 * Stores the off-chain metadata (nickname, sender address) that only
 * the sender knows at the time of sending.
 *
 * The event listener independently picks up TransferInitiated and upserts
 * the on-chain fields. This endpoint upserts the off-chain overlay.
 *
 * Idempotent: re-calling with the same transferId updates, never duplicates.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db, transfers } from '@/lib/db'

const metadataSchema = z.object({
  transferId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  senderAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  recipientPhoneHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  recipientNickname: z.string().max(50).optional(),
  amount: z.string().optional(),   // QUSD base units as string
  corridor: z.string().optional(),
})

export async function POST(req: NextRequest) {
  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const parsed = metadataSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const data = parsed.data

  if (!db) {
    // No DB — log and return success (event listener will pick up on-chain data)
    console.log('[transfers/metadata] DB not configured — metadata dropped for', data.transferId.slice(0, 10))
    return NextResponse.json({ ok: true, warning: 'DB not configured' })
  }

  await db
    .insert(transfers)
    .values({
      id: data.transferId,
      txHash: data.txHash ?? null,
      senderAddress: data.senderAddress.toLowerCase(),
      recipientPhoneHash: data.recipientPhoneHash ?? '0x' + '0'.repeat(64),
      recipientNickname: data.recipientNickname ?? null,
      amount: data.amount ?? '0',
      corridor: data.corridor ?? '',
      status: 0,
      smsStatus: 'PENDING',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: transfers.id,
      set: {
        txHash: data.txHash ?? undefined,
        recipientNickname: data.recipientNickname ?? undefined,
        senderAddress: data.senderAddress.toLowerCase(),
        updatedAt: Date.now(),
      },
    })

  return NextResponse.json({ ok: true })
}
