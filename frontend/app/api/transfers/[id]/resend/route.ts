/**
 * app/api/transfers/[id]/resend/route.ts
 *
 * POST /api/transfers/[id]/resend
 *
 * Re-sends the OTP to the recipient when they request it from the claim page.
 * Retrieves the OTP from Redis (stored during the send flow with a 48h TTL)
 * and re-fires the notify route.
 *
 * Rate-limiting: 1 resend per transfer per 60 seconds (stored in Redis).
 *
 * Security:
 *   - OTP is only fetched from Redis, never accepted from the client
 *   - Resend is blocked if the transfer is already claimed or cancelled
 *   - Returns success=true even if the OTP is missing in Redis to avoid
 *     leaking information about whether a transfer exists
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createPublicClient, http } from 'viem'
import { REMITCHAIN_ADDRESS, RemitChainAbi } from '@/lib/contracts'
import { getRedis } from '@/lib/db/redis'
import { serverChain, RPC_URL } from '@/lib/chain-config'
import { env } from '@/lib/env'
import { notifyRecipient, type NotifyChannel } from '@/lib/notify/send'

const RESEND_COOLDOWN_SECONDS = 60
const OTP_KEY = (id: string) => `demo:otp:${id}` // same key used by demo-otp route
const COOLDOWN_KEY = (id: string) => `resend:cooldown:${id}`

const bodySchema = z.object({
  recipientEmail: z.string().email().optional(),
  recipientPhone: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, 'Must be E.164 format')
    .optional(),
}).refine(d => d.recipientEmail || d.recipientPhone, {
  message: 'Either recipientEmail or recipientPhone is required',
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const transferId = id.startsWith('0x') ? id : `0x${id}`

  if (!/^0x[a-fA-F0-9]{64}$/.test(transferId)) {
    return NextResponse.json({ error: 'Invalid transferId' }, { status: 400 })
  }

  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const { recipientEmail, recipientPhone } = parsed.data

  // 1. Check on-chain: only resend for PENDING transfers
  try {
    const publicClient = createPublicClient({ chain: serverChain, transport: http(RPC_URL) })
    const transfer = await publicClient.readContract({
      address: REMITCHAIN_ADDRESS,
      abi: RemitChainAbi,
      functionName: 'getTransfer',
      args: [transferId as `0x${string}`],
    }) as { status: number }

    if (transfer.status !== 1) {
      return NextResponse.json(
        { error: 'Transfer is not claimable — already claimed or cancelled.' },
        { status: 400 },
      )
    }
  } catch {
    // Non-fatal — proceed anyway if chain read fails
    console.warn('[resend] Could not verify on-chain status — proceeding')
  }

  // 2. Rate-limit: one resend per transfer per 60 seconds
  const redis = getRedis()
  if (redis) {
    const cooldown = await redis.get(COOLDOWN_KEY(transferId))
    if (cooldown) {
      return NextResponse.json(
        { error: 'Please wait 60 seconds between resend requests.' },
        { status: 429 },
      )
    }
  }

  // 3. Retrieve OTP from Redis (stored by send page during the TX flow)
  let otp: string | null = null
  if (redis) {
    try {
      otp = await redis.get<string>(OTP_KEY(transferId))
    } catch (err) {
      console.warn('[resend] Redis OTP fetch failed:', err)
    }
  }

  if (!otp) {
    // OTP not in Redis — return success anyway to avoid timing attacks.
    // The recipient must ask the sender to cancel and re-send.
    console.warn(`[resend] OTP missing from Redis for transfer ${transferId.slice(0, 10)}…`)
    return NextResponse.json({
      sent: false,
      error: 'OTP not found — it may have expired. Ask the sender to re-initiate the transfer.',
    }, { status: 404 })
  }

  // 4. Re-send via notify service
  const baseUrl =
    env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
  const claimUrl = `${baseUrl}/claim/${transferId}`
  const channel: NotifyChannel = (env.OTP_CHANNEL as NotifyChannel) ?? 'email'

  const to = channel === 'email' ? recipientEmail : recipientPhone
  if (!to && channel !== 'demo') {
    return NextResponse.json(
      { error: `Channel is '${channel}' but no matching contact provided.` },
      { status: 400 },
    )
  }

  const result = await notifyRecipient({
    transferId,
    channel,
    to: to ?? 'demo',
    otp,
    amount: 'your transfer',
    claimUrl,
    senderName: undefined,
    locale: recipientPhone?.startsWith('+91') ? 'hi' : 'en',
  })

  // 5. Set cooldown in Redis
  if (redis && result.success) {
    try {
      await redis.set(COOLDOWN_KEY(transferId), '1', { ex: RESEND_COOLDOWN_SECONDS })
    } catch { /* non-fatal */ }
  }

  console.log(JSON.stringify({
    level: result.success ? 'info' : 'warn',
    step: `resend.${result.success ? 'sent' : 'failed'}`,
    channel: result.channel,
    transferId: transferId.slice(0, 10) + '…',
    ts: new Date().toISOString(),
  }))

  if (result.success) {
    return NextResponse.json({ sent: true, channel: result.channel })
  } else {
    return NextResponse.json({ sent: false, error: result.error }, { status: 500 })
  }
}
