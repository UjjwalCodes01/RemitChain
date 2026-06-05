/**
 * lib/notify/send.ts
 *
 * Provider-agnostic notification layer for RemitChain OTP delivery.
 *
 * Supported channels:
 *   'email' — Resend (free tier, 3000/month; production default on mainnet)
 *   'sms'   — Twilio (optional; retained for compatibility, inactive unless configured)
 *   'demo'  — On-screen only via /api/transfers/[id]/demo-otp (testnet only)
 *
 * Channel is selected by the OTP_CHANNEL environment variable (default: 'email').
 *
 * SECURITY: Never logs the OTP in production. Uses structured logs with masked values.
 */

import { env } from '@/lib/env'
import { sendSms } from '@/lib/sms/send'
import {
  buildOtpEmailHtml,
  buildOtpEmailPlaintext,
  getEmailSubject,
  type EmailTemplateData,
} from './templates/email'

// ── Types ─────────────────────────────────────────────────────────────────────

export type NotifyChannel = 'email' | 'sms' | 'demo'

export interface NotifyPayload {
  transferId: string
  channel?: NotifyChannel          // override; defaults to env.OTP_CHANNEL
  to: string                       // email address or E.164 phone depending on channel
  otp: string                      // 6-digit plaintext OTP
  amount: string                   // formatted display amount e.g. "50.00 QUSD"
  claimUrl: string                 // full URL to /claim/{txId}
  senderName?: string              // optional — e.g. "Rahul"
  locale?: 'en' | 'hi'
}

export interface NotifyResult {
  channel: NotifyChannel
  success: boolean
  error?: string
  messageId?: string               // Resend/Twilio message ID if available
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * notifyRecipient — sends the OTP to the recipient via the configured channel.
 * Never throws — returns a NotifyResult with success=false on failure.
 */
export async function notifyRecipient(payload: NotifyPayload): Promise<NotifyResult> {
  const channel: NotifyChannel = payload.channel ?? (env.OTP_CHANNEL as NotifyChannel) ?? 'email'

  switch (channel) {
    case 'email':
      return sendOtpEmail(payload)
    case 'sms':
      return sendOtpSms(payload)
    case 'demo':
      // Demo channel: OTP is surfaced on-screen by the demo-otp API route.
      // Nothing to send here — just log and return success.
      console.log(`[DEMO] OTP for transfer ${payload.transferId.slice(0, 10)}… is on-screen`)
      return { channel: 'demo', success: true }
    default:
      return { channel: 'email', success: false, error: `Unknown channel: ${channel}` }
  }
}

// ── Email via Resend ──────────────────────────────────────────────────────────

async function sendOtpEmail(payload: NotifyPayload): Promise<NotifyResult> {
  const { to, otp, amount, claimUrl, senderName, locale = 'en', transferId } = payload
  const { RESEND_API_KEY, RESEND_FROM } = env

  // Stub when Resend is not configured — useful for local dev
  if (!RESEND_API_KEY) {
    console.log(`[EMAIL-STUB] To: ${to} | Transfer: ${transferId.slice(0, 10)}… | OTP: [REDACTED]`)
    console.log(`[EMAIL-STUB] Claim URL: ${claimUrl}`)
    return { channel: 'email', success: true }
  }

  const templateData: EmailTemplateData = {
    otp,
    amount,
    senderName,
    claimUrl,
    expiresInHours: 48,
    locale,
  }

  const fromAddress = RESEND_FROM || 'RemitChain <onboarding@resend.dev>'
  const subject = getEmailSubject(amount, locale)
  const html = buildOtpEmailHtml(templateData)
  const text = buildOtpEmailPlaintext(templateData)

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [to],
        subject,
        html,
        text,
        tags: [
          { name: 'product', value: 'remitchain' },
          { name: 'type', value: 'otp' },
        ],
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      const error = `Resend ${res.status}: ${body.slice(0, 300)}`
      console.error(`[EMAIL] Failed for transfer ${transferId.slice(0, 10)}…:`, error)
      return { channel: 'email', success: false, error }
    }

    const data = await res.json() as { id?: string }
    console.log(`[EMAIL] Sent for transfer ${transferId.slice(0, 10)}… | id=${data.id}`)
    return { channel: 'email', success: true, messageId: data.id }

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error(`[EMAIL] Network error for ${transferId.slice(0, 10)}…:`, error)
    return { channel: 'email', success: false, error }
  }
}

// ── SMS via Twilio (backward compat) ─────────────────────────────────────────

async function sendOtpSms(payload: NotifyPayload): Promise<NotifyResult> {
  const { to, otp, amount, claimUrl } = payload

  const body =
    `You've received ${amount} on RemitChain.\n` +
    `Your 6-digit claim code: ${otp}\n` +
    `Claim here: ${claimUrl}\n` +
    `Expires in 48h. Keep this code secret.`

  const result = await sendSms({ to, body })
  return {
    channel: 'sms',
    success: result.success,
    error: result.error,
  }
}
