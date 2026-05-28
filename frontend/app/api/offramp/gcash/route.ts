/**
 * app/api/offramp/gcash/route.ts
 *
 * GCash off-ramp — Philippines corridor.
 *
 * Real provider: Xendit (https://xendit.co) — PayOut API with GCash as channel.
 * TODO(gcash): Replace stub with Xendit API call.
 *   POST https://api.xendit.co/disbursements
 *   Headers: Authorization: Basic <base64(XENDIT_SECRET_KEY:)>
 *   Body: { external_id, bank_code: "GCASH", account_holder_name, account_number, amount, description }
 *
 * Same idempotency + DB + on-chain guard pattern as UPI.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { createPublicClient, http } from 'viem'
import { REMITCHAIN_ADDRESS, RemitChainAbi } from '@/lib/contracts'
import { db, transfers } from '@/lib/db'

const qieChain = {
  id: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? '1983'),
  name: 'QIE Testnet',
  nativeCurrency: { name: 'QIE', symbol: 'QIE', decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_RPC_URL ?? 'https://rpc1testnet.qie.digital/'] } },
} as const

const gcashSchema = z.object({
  transferId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  gcashNumber: z.string().regex(/^09\d{9}$/, 'GCash number must be 11 digits starting with 09'),
  recipientName: z.string().min(1).max(50),
})

export async function POST(req: NextRequest) {
  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const parsed = gcashSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const { transferId, gcashNumber, recipientName } = parsed.data

  // 1. On-chain claimed guard (same as UPI — never pay unclaimed)
  const publicClient = createPublicClient({ chain: qieChain, transport: http() })
  try {
    const transfer = await publicClient.readContract({
      address: REMITCHAIN_ADDRESS,
      abi: RemitChainAbi,
      functionName: 'getTransfer',
      args: [transferId as `0x${string}`],
    }) as { status: number }

    if (transfer.status !== 1) {
      return NextResponse.json(
        { error: 'Transfer is not claimed on-chain. Cannot pay out unclaimed transfer.' },
        { status: 400 },
      )
    }
  } catch (err) {
    return NextResponse.json({ error: 'Failed to verify on-chain status' }, { status: 502 })
  }

  // 2. DB idempotency
  if (db) {
    const rows = await db.select({
      offrampStatus: transfers.offrampStatus,
      offrampReference: transfers.offrampReference,
    }).from(transfers).where(eq(transfers.id, transferId)).limit(1)

    const row = rows[0]
    if (row?.offrampStatus === 'COMPLETED' && row.offrampReference) {
      return NextResponse.json({
        disbursementId: row.offrampReference,
        status: 'completed',
        idempotent: true,
      })
    }

    await db
      .update(transfers)
      .set({ offrampStatus: 'PENDING', offrampMethod: 'GCASH', updatedAt: Date.now() })
      .where(eq(transfers.id, transferId))
  }

  // 3. Stub response (Xendit not yet integrated)
  // TODO(gcash): Implement Xendit disbursement API call here.
  // const xenditSecret = process.env.XENDIT_SECRET_KEY
  // if (xenditSecret) { ... real call ... }

  const stubId = `gcash_stub_${Date.now()}_${transferId.slice(2, 8)}`

  if (db) {
    await db
      .update(transfers)
      .set({
        offrampStatus: 'COMPLETED',
        offrampReference: stubId,
        offrampMethod: 'GCASH',
        updatedAt: Date.now(),
      })
      .where(eq(transfers.id, transferId))
  }

  console.log(JSON.stringify({
    level: 'info',
    step: 'offramp.gcash_stub',
    transferId: transferId.slice(0, 10) + '…',
    gcashNumber: gcashNumber.slice(0, 5) + '…',
    recipientName,
    stubId,
    ts: new Date().toISOString(),
  }))

  return NextResponse.json({
    disbursementId: stubId,
    status: 'processing',
    eta: '10-15 minutes',
    channel: 'GCASH',
    note: 'Stub mode — Xendit integration pending (see TODO in route.ts)',
  })
}
