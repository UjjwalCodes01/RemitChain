/**
 * app/api/notify/route.ts
 *
 * Sends the recipient a claim link via SMS after a transfer is initiated.
 *
 * OTP delivery model:
 *   The OTP commit-reveal means only the SENDER knows the raw 6-digit OTP.
 *   This route sends the recipient a claim URL (/claim/[txId]) via SMS.
 *   The sender shares the 6-digit code with the recipient verbally or via WhatsApp.
 *
 * Twilio:
 *   If TWILIO_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM are configured → real SMS.
 *   Otherwise → logs [SMS-STUB] to console (functional for local demo).
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { env } from '@/lib/env'
import { db, transfers } from '@/lib/db'

// ── Input schema ─────────────────────────────────────────────────────────────

const notifySchema = z.object({
  transferId: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'transferId must be a bytes32 hex string'),
  recipientPhone: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, 'recipientPhone must be E.164 format'),
  amount: z.number().positive(),
  corridor: z.string().min(1),
})

// ── Language detection ────────────────────────────────────────────────────────

function detectLang(phone: string): 'en' | 'hi' {
  // +91 → India (Hindi fallback)
  if (phone.startsWith('+91')) return 'hi'
  return 'en'
}

// ── SMS message builders ─────────────────────────────────────────────────────

function buildMessage(params: {
  lang: 'en' | 'hi'
  amount: number
  corridor: string
  claimUrl: string
}): string {
  const { lang, amount, corridor, claimUrl } = params

  if (lang === 'hi') {
    return (
      `RemitChain: आपको $${amount.toFixed(2)} QUSD मिले हैं (${corridor} कॉरिडोर)। ` +
      `भेजने वाले से 6-अंकों का कोड मांगें, फिर यहाँ क्लेम करें: ${claimUrl} ` +
      `(48 घंटों में समाप्त होगा)`
    )
  }

  return (
    `RemitChain: You have received $${amount.toFixed(2)} QUSD (${corridor} corridor). ` +
    `Ask the sender for the 6-digit code, then claim here: ${claimUrl} ` +
    `(expires in 48 hours)`
  )
}

// ── Twilio sender ─────────────────────────────────────────────────────────────

async function sendSms(to: string, body: string): Promise<'sms' | 'stub'> {
  const { TWILIO_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM } = env

  if (!TWILIO_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM) {
    console.log(`[SMS-STUB] To: ${to}\n${body}`)
    return 'stub'
  }

  // Use Twilio REST API directly — no SDK dependency needed
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')

  const form = new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body })

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Twilio error ${res.status}: ${text.slice(0, 200)}`)
  }

  return 'sms'
}

// ── DB helper ────────────────────────────────────────────────────────────────

async function updateSmsStatus(transferId: string, status: 'SENT' | 'FAILED') {
  if (!db) return
  try {
    await db
      .update(transfers)
      .set({ smsStatus: status, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(transfers.id, transferId))
  } catch (err) {
    console.warn('[notify] DB smsStatus update failed (non-fatal):', err)
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

  const { transferId, recipientPhone, amount, corridor } = parsed.data

  const baseUrl =
    env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

  const claimUrl = `${baseUrl}/claim/${transferId}`
  const lang = detectLang(recipientPhone)
  const message = buildMessage({ lang, amount, corridor, claimUrl })

  try {
    const channel = await sendSms(recipientPhone, message)

    // ✅ Mark SMS as delivered in DB — this is what moves it out of "Pending" in the UI
    await updateSmsStatus(transferId, 'SENT')

    console.log(
      JSON.stringify({
        level: 'info',
        step: 'notify.sent',
        channel,
        transferId: transferId.slice(0, 10) + '…',
        ts: new Date().toISOString(),
      }),
    )

    return NextResponse.json({ sent: true, channel })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(
      JSON.stringify({
        level: 'error',
        step: 'notify.failed',
        err: msg.slice(0, 200),
        ts: new Date().toISOString(),
      }),
    )

    // ❌ Mark SMS as failed — surfaces in dashboard/stats as "SMS failed" instead of limbo
    await updateSmsStatus(transferId, 'FAILED')

    // Non-fatal: don't fail the caller, just report
    return NextResponse.json({ sent: false, error: msg }, { status: 500 })
  }
}
