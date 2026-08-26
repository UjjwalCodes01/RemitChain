/**
 * POST /api/transfers/confirm
 *
 * Step 2 of sending. The wallet has broadcast `sendRemittance`; this verifies
 * the transaction actually landed and then delivers the claim link and OTP to
 * the recipient.
 *
 * The notification is sent from HERE, not from the browser, and the OTP comes
 * from the database rather than the request body. The old flow had the sender's
 * browser POST `{transferId, otp, recipientEmail}` to an unauthenticated
 * /api/notify — anyone could send a chosen code for someone else's transfer to
 * an address they controlled. Nothing in this request can influence what is
 * sent or where.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createPublicClient, http, decodeEventLog, type Hex } from 'viem'
import { eq } from 'drizzle-orm'
import { env } from '@/lib/env'
import { serverChain } from '@/lib/chain-config'
import { REMITCHAIN_ADDRESS, RemitChainAbi } from '@/lib/contracts'
import { db, transfers } from '@/lib/db'
import { deliverClaimNotification } from '@/lib/notify/deliver'
import { getRedis } from '@/lib/db/redis'
import { rateLimit } from '@/lib/ratelimit'
import { log, shortId } from '@/lib/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const confirmSchema = z.object({
  transferId: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
})

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = confirmSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const { transferId, txHash } = parsed.data

  const limited = await rateLimit('confirm', transferId, { limit: 10, windowSeconds: 600 })
  if (!limited.success) {
    return NextResponse.json({ error: 'Too many attempts' }, { status: 429 })
  }

  if (!db) {
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 })
  }

  const rows = await db.select().from(transfers).where(eq(transfers.id, transferId)).limit(1)
  const row = rows[0]
  if (!row) {
    return NextResponse.json({ error: 'Unknown transfer' }, { status: 404 })
  }

  // Already confirmed and delivered — nothing to do.
  if (row.txHash && row.notifyStatus === 'SENT') {
    return NextResponse.json({ ok: true, alreadyConfirmed: true, notified: true })
  }

  // ── Verify the transaction on-chain ────────────────────────────────────────
  const publicClient = createPublicClient({ chain: serverChain, transport: http(env.NEXT_PUBLIC_RPC_URL) })

  let receipt
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash as Hex,
      confirmations: 1,
      timeout: 60_000,
    })
  } catch (err) {
    log('warn', 'confirm.receipt_unavailable', { transferId: shortId(transferId), err: String(err).slice(0, 160) })
    return NextResponse.json(
      { error: 'The transaction has not confirmed yet. Please try again in a moment.', code: 'PENDING' },
      { status: 202 },
    )
  }

  if (receipt.status !== 'success') {
    await db
      .update(transfers)
      .set({ notifyStatus: 'FAILED', notifyLastError: 'Send transaction reverted', updatedAt: Date.now() })
      .where(eq(transfers.id, transferId))
    return NextResponse.json({ error: 'The send transaction failed on-chain.' }, { status: 400 })
  }

  // ── The event is authoritative for the transfer id ────────────────────────
  // The id derives from the sender's nonce, which another transaction could
  // have moved between prepare and broadcast. If that happened, the commitment
  // we generated belongs to a different id and the funds cannot be claimed —
  // so say so plainly rather than sending a code that will never work.
  const emitted = extractTransferInitiated(receipt.logs)

  if (!emitted) {
    return NextResponse.json(
      { error: 'That transaction does not contain a RemitChain transfer.' },
      { status: 400 },
    )
  }

  if (emitted.transferId.toLowerCase() !== transferId.toLowerCase()) {
    log('error', 'confirm.transfer_id_mismatch', {
      expected: shortId(transferId),
      actual: shortId(emitted.transferId),
      txHash,
    })
    await db
      .update(transfers)
      .set({
        notifyStatus: 'FAILED',
        notifyLastError: `Nonce race: chain emitted ${emitted.transferId}`,
        updatedAt: Date.now(),
      })
      .where(eq(transfers.id, transferId))

    return NextResponse.json(
      {
        error:
          'Another transaction from this wallet confirmed first, so this transfer could not be ' +
          'linked to its claim code. Your funds are safe — cancel the transfer to get an ' +
          'immediate refund, then send again.',
        code: 'NONCE_RACE',
        onChainTransferId: emitted.transferId,
      },
      { status: 409 },
    )
  }

  // ── Persist the confirmed on-chain facts ──────────────────────────────────
  const now = Date.now()
  await db
    .update(transfers)
    .set({
      txHash,
      // Expiry is emitted in seconds; every timestamp in this schema is ms.
      expiry: Number(emitted.expiry) * 1000,
      amount: emitted.amount.toString(),
      updatedAt: now,
    })
    .where(eq(transfers.id, transferId))

  // Preparation is finished, so release the per-sender lock immediately rather
  // than waiting for its TTL — the sender can start their next transfer now.
  const redis = getRedis()
  if (redis) await redis.del(`lock:prepare:${row.senderAddress.toLowerCase()}`)

  // ── Deliver the claim credentials ─────────────────────────────────────────
  const delivery = await deliverClaimNotification(transferId)

  return NextResponse.json({
    ok: true,
    transferId,
    txHash,
    expiry: Number(emitted.expiry) * 1000,
    notified: delivery.sent,
    channel: delivery.channel,
    notifyError: delivery.error,
  })
}

// ─── Event decoding ──────────────────────────────────────────────────────────

interface EmittedTransfer {
  transferId: string
  amount: bigint
  expiry: bigint
  corridor: number
}

function extractTransferInitiated(logs: readonly { address: string; topics: readonly string[]; data: string }[]) {
  for (const entry of logs) {
    if (entry.address.toLowerCase() !== REMITCHAIN_ADDRESS.toLowerCase()) continue
    try {
      const decoded = decodeEventLog({
        abi: RemitChainAbi,
        data: entry.data as Hex,
        topics: entry.topics as [Hex, ...Hex[]],
      })
      if (decoded.eventName !== 'TransferInitiated') continue
      const args = decoded.args as unknown as {
        transferId: Hex
        amount: bigint
        expiry: bigint
        corridor: number
      }
      return {
        transferId: args.transferId,
        amount: args.amount,
        expiry: args.expiry,
        corridor: Number(args.corridor),
      } satisfies EmittedTransfer
    } catch {
      // Not the event we are after — keep scanning.
    }
  }
  return null
}
