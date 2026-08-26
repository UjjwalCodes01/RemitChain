/**
 * POST /api/transfers/[id]/resend
 *
 * Re-sends the claim link and code to the recipient already on file.
 *
 * The caller cannot influence what is sent or where it goes. The old version
 * accepted `{recipientEmail}` in the body and delivered the OTP there, which
 * meant anyone who knew a transfer id could have its claim code mailed to an
 * address of their choosing — the transfer id is public on-chain, so that was
 * the whole credential.
 *
 * The destination now comes from the transfer record written at prepare time,
 * and the credentials come from encrypted storage. The body is empty.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, type Hex } from 'viem'
import { eq } from 'drizzle-orm'
import { REMITCHAIN_ADDRESS, RemitChainAbi } from '@/lib/contracts'
import { serverChain, RPC_URL } from '@/lib/chain-config'
import { db, transfers } from '@/lib/db'
import { ChainStatus } from '@/lib/relayer/claim'
import { deliverClaimNotification } from '@/lib/notify/deliver'
import { rateLimit } from '@/lib/ratelimit'
import { clientIp, log, shortId } from '@/lib/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const transferId = id.startsWith('0x') ? id : `0x${id}`

  if (!/^0x[a-fA-F0-9]{64}$/.test(transferId)) {
    return NextResponse.json({ error: 'Invalid transfer reference' }, { status: 400 })
  }

  // One resend per transfer per minute, five per hour. The lower bound stops
  // someone using us to spam a recipient's inbox.
  const perMinute = await rateLimit('resend:min', transferId, { limit: 1, windowSeconds: 60 })
  if (!perMinute.success) {
    return NextResponse.json(
      { error: 'Please wait a minute before requesting another code.' },
      { status: 429, headers: { 'Retry-After': String(perMinute.retryAfterSeconds) } },
    )
  }

  const perHour = await rateLimit('resend:hour', transferId, { limit: 5, windowSeconds: 3600 })
  if (!perHour.success) {
    return NextResponse.json(
      { error: 'Too many resend requests for this transfer. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(perHour.retryAfterSeconds) } },
    )
  }

  const ipLimit = await rateLimit('resend:ip', clientIp(_req), { limit: 20, windowSeconds: 3600 })
  if (!ipLimit.success) {
    return NextResponse.json({ error: 'Too many requests.' }, { status: 429 })
  }

  // Only a pending transfer can be resent.
  try {
    const publicClient = createPublicClient({ chain: serverChain, transport: http(RPC_URL) })
    const transfer = (await publicClient.readContract({
      address: REMITCHAIN_ADDRESS,
      abi: RemitChainAbi,
      functionName: 'getTransfer',
      args: [transferId as Hex],
    })) as { status: number; expiry: bigint }

    if (transfer.status !== ChainStatus.PENDING) {
      return NextResponse.json(
        { error: 'This transfer has already been claimed or cancelled.' },
        { status: 409 },
      )
    }
    if (BigInt(Math.floor(Date.now() / 1000)) >= transfer.expiry) {
      return NextResponse.json({ error: 'This transfer has expired.' }, { status: 410 })
    }
  } catch (err) {
    log('warn', 'resend.chain_read_failed', { err: String(err).slice(0, 160) })
    return NextResponse.json(
      { error: 'We could not reach the network. Please try again.' },
      { status: 502 },
    )
  }

  if (!db) {
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 })
  }

  const rows = await db
    .select({ id: transfers.id })
    .from(transfers)
    .where(eq(transfers.id, transferId))
    .limit(1)

  if (rows.length === 0) {
    return NextResponse.json(
      { error: 'We no longer hold the claim details for this transfer. Ask the sender to cancel and send again.' },
      { status: 404 },
    )
  }

  const result = await deliverClaimNotification(transferId)

  log(result.sent ? 'info' : 'warn', `resend.${result.sent ? 'sent' : 'failed'}`, {
    transferId: shortId(transferId),
    channel: result.channel,
  })

  if (!result.sent) {
    return NextResponse.json(
      { sent: false, error: result.error ?? 'We could not resend the code. Please try again.' },
      { status: 500 },
    )
  }

  return NextResponse.json({ sent: true, channel: result.channel })
}
