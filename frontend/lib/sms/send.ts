/**
 * lib/sms/send.ts
 *
 * Provider-agnostic SMS abstraction for RemitChain.
 *
 * Usage:
 *   const result = await sendSms({ to: '+919876543210', body: 'Your code: ...' })
 *
 * Providers:
 *   - Twilio: used when TWILIO_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM are set
 *   - Stub:   logs [SMS-STUB] to console when Twilio is not configured
 *             (functional for local dev — OTPs still work, just no SMS)
 *
 * In Demo Mode, the OTP is also surfaced on-screen via the demo-otp API.
 * No extra action is needed here — the frontend reads it from
 * /api/transfers/[id]/demo-otp.
 */

import { env } from '@/lib/env'

export type SmsChannel = 'twilio' | 'stub'

export interface SmsPayload {
  to: string   // E.164 phone number
  body: string // SMS message body
}

export interface SmsResult {
  channel: SmsChannel
  success: boolean
  error?: string
}

/**
 * sendSms — sends an SMS via the configured provider.
 * Never throws — returns an SmsResult with success=false on failure.
 */
export async function sendSms({ to, body }: SmsPayload): Promise<SmsResult> {
  const { TWILIO_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM } = env

  // ── Stub path (no Twilio configured) ────────────────────────────────────────
  if (!TWILIO_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM) {
    console.log(`[SMS-STUB] To: ${to}\n${body}`)
    return { channel: 'stub', success: true }
  }

  // ── Twilio path ──────────────────────────────────────────────────────────────
  // Using the REST API directly — avoids the Twilio SDK dependency.
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
  const form = new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body })

  try {
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
      return {
        channel: 'twilio',
        success: false,
        error: `Twilio ${res.status}: ${text.slice(0, 200)}`,
      }
    }

    return { channel: 'twilio', success: true }
  } catch (err) {
    return {
      channel: 'twilio',
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
