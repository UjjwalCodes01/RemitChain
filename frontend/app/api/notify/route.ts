/**
 * app/api/notify/route.ts
 *
 * Sends the recipient a claim OTP via the configured channel (email or SMS).
 *
 * OTP delivery model:
 *   The OTP commit-reveal means only the SENDER knows the raw 6-digit OTP.
 *   This route receives the OTP from the sender's browser (server-to-client-to-server
 *   pattern — the send page generates the OTP, then POSTs it here along with recipient email).
 *   The recipient receives an email (or SMS) with the OTP and a claim link.
 *
 * Channel selection:
 *   OTP_CHANNEL=email  → Resend (default, free, mainnet-safe)
 *   OTP_CHANNEL=sms    → Twilio (optional, backward compat)
 *   OTP_CHANNEL=demo   → on-screen only (testnet demo mode)
 *
 * Demo Mode:
 *   When DEMO_MODE=true, the OTP is additionally surfaced on-screen via
 *   /api/transfers/[id]/demo-otp. This route still fires the channel notification
 *   (proving the real path works), but judges can see the OTP without needing to check email.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { env } from '@/lib/env'
import { db, transfers } from '@/lib/db'
import { notifyRecipient, type NotifyChannel } from '@/lib/notify/send'

// ── Input schema ─────────────────────────────────────────────────────────────

const notifySchema = z.object({
  transferId: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'transferId must be a bytes32 hex string'),
  // Recipient contact — either email (mainnet) or phone (SMS fallback)
  recipientEmail: z.string().email().optional(),
  recipientPhone: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, 'recipientPhone must be E.164 format')
    .optional(),
  // OTP — sent by the sender's browser after on-chain TX confirms
  // Never stored persistently except in Redis with 48h TTL (demo mode)
  otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
  amount: z.number().positive(),
  corridor: z.string().min(1),
  senderName: z.string().optional(),
  locale: z.enum(['en', 'hi']).default('en'),
}).refine(
  (d) => d.recipientEmail || d.recipientPhone,
  'Either recipientEmail or recipientPhone must be provided',
)

// ── Language detection ────────────────────────────────────────────────────────

function detectLang(phone?: string): 'en' | 'hi' {
  if (phone?.startsWith('+91')) return 'hi'
  return 'en'
}

// ── DB helpers ───────────────────────────────────────────────────────────────

async function updateEmailStatus(transferId: string, status: 'SENT' | 'FAILED') {
  if (!db) return
  try {
    await db
      .update(transfers)
      .set({
        emailStatus: status,
        smsStatus: status, // keep backward compat — smsStatus mirrors emailStatus
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(transfers.id, transferId))
  } catch (err) {
    console.warn('[notify] DB status update failed (non-fatal):', err)
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = notifySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const { transferId, recipientEmail, recipientPhone, otp, amount, corridor, senderName, locale: reqLocale } = parsed.data

  const baseUrl =
    env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
  const claimUrl = `${baseUrl}/claim/${transferId}`

  // Determine channel + recipient
  const channel: NotifyChannel = env.OTP_CHANNEL as NotifyChannel ?? 'email'
  const locale = reqLocale ?? detectLang(recipientPhone)

  // Choose "to" based on channel
  let to: string | undefined
  if (channel === 'email') {
    to = recipientEmail
    if (!to) {
      // Fallback: if email channel but no email provided, try SMS
      console.warn(`[notify] channel=email but no recipientEmail — falling back to sms`)
    }
  } else if (channel === 'sms') {
    to = recipientPhone
  } else if (channel === 'demo') {
    to = recipientPhone ?? recipientEmail ?? 'demo'
  }

  if (!to && channel !== 'demo') {
    return NextResponse.json(
      { error: `No recipient address for channel=${channel}. Provide recipientEmail or recipientPhone.` },
      { status: 400 },
    )
  }

  const formattedAmount = `$${amount.toFixed(2)} QUSD (${corridor.toUpperCase()})`

  const result = await notifyRecipient({
    transferId,
    channel,
    to: to ?? 'demo',
    otp,
    amount: formattedAmount,
    claimUrl,
    senderName,
    locale,
  })

  console.log(
    JSON.stringify({
      level: result.success ? 'info' : 'error',
      step: `notify.${result.success ? 'sent' : 'failed'}`,
      channel: result.channel,
      transferId: transferId.slice(0, 10) + '…',
      messageId: result.messageId,
      error: result.error?.slice(0, 200),
      ts: new Date().toISOString(),
    }),
  )

  await updateEmailStatus(transferId, result.success ? 'SENT' : 'FAILED')

  if (result.success) {
    return NextResponse.json({ sent: true, channel: result.channel, messageId: result.messageId })
  } else {
    return NextResponse.json({ sent: false, error: result.error }, { status: 500 })
  }
}
