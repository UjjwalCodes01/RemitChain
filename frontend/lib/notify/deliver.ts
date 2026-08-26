/**
 * lib/notify/deliver.ts
 *
 * The one place that can turn a stored transfer into a message containing its
 * claim credentials.
 *
 * Both /api/transfers/confirm and /api/transfers/[id]/resend go through here,
 * so there is exactly one code path that reads the encrypted claim secret and
 * decides where it is sent. Nothing in either request body can influence the
 * destination — it comes from the transfer record written at prepare time.
 */

import 'server-only'
import { eq } from 'drizzle-orm'
import { appUrl } from '@/lib/env'
import { db, transfers } from '@/lib/db'
import { getCorridorById } from '@/lib/corridors'
import { decryptSecret } from '@/lib/crypto/secretbox'
import { notifyRecipient } from '@/lib/notify/send'
import { log, shortId } from '@/lib/http'

export interface DeliveryResult {
  sent: boolean
  channel?: string
  error?: string
}

/** Send the recipient their claim link and OTP. */
export async function deliverClaimNotification(transferId: string): Promise<DeliveryResult> {
  if (!db) return { sent: false, error: 'Database unavailable' }

  const rows = await db.select().from(transfers).where(eq(transfers.id, transferId)).limit(1)
  const row = rows[0]
  if (!row) return { sent: false, error: 'Unknown transfer' }

  const claimSecret = row.claimSecretEnc ? decryptSecret(row.claimSecretEnc) : null
  const otp = row.otpEnc ? decryptSecret(row.otpEnc) : null

  if (!claimSecret || !otp) {
    return { sent: false, error: 'Claim credentials are no longer available for this transfer' }
  }

  const corridor = getCorridorById(row.corridor)
  const channel = (row.notifyChannel as 'email' | 'sms') ?? 'email'
  const to = channel === 'email' ? row.recipientEmail : null

  if (!to) {
    return { sent: false, error: `No ${channel} address on file for this transfer` }
  }

  // The secret rides in the URL fragment. Fragments are never sent to the
  // server, so it stays out of access logs, Referer headers and any CDN in
  // between — unlike a query parameter.
  const claimUrl = `${appUrl()}/claim/${transferId}#s=${claimSecret}`

  const amountDisplay =
    row.quotedLocalMinor && corridor
      ? `${corridor.currencySymbol}${(Number(row.quotedLocalMinor) / corridor.minorUnits).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `${(Number(row.netAmount ?? row.amount) / 1e6).toFixed(2)} QUSD`

  const result = await notifyRecipient({
    transferId,
    channel,
    to,
    otp,
    amount: amountDisplay,
    claimUrl,
    senderName: row.recipientNickname ?? undefined,
    locale: 'en',
  })

  await db
    .update(transfers)
    .set({
      notifyStatus: result.success ? 'SENT' : 'FAILED',
      notifyAttempts: row.notifyAttempts + 1,
      notifyLastError: result.error?.slice(0, 300) ?? null,
      updatedAt: Date.now(),
    })
    .where(eq(transfers.id, transferId))

  log(result.success ? 'info' : 'error', `notify.${result.success ? 'sent' : 'failed'}`, {
    transferId: shortId(transferId),
    channel: result.channel,
    error: result.error?.slice(0, 200),
  })

  return { sent: result.success, channel: result.channel, error: result.error }
}
