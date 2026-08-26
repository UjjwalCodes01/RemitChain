/**
 * GET /api/health
 *
 * Operational readiness. Safe to expose publicly — booleans and corridor
 * status only, never a secret or a value derived from one.
 *
 * The previous version reported `status: 'ok'` whenever the database and
 * relayer were configured, and always returned HTTP 200 with the comment
 * "degraded is not an error". A remittance service that cannot pay anyone is
 * not healthy, and an uptime monitor that only ever sees 200 cannot tell you
 * so. This returns 503 when the product genuinely cannot do its job.
 */

import { NextResponse } from 'next/server'
import { IS_PRODUCTION_CHAIN, env } from '@/lib/env'
import { isDbAvailable } from '@/lib/db'
import { getRedis } from '@/lib/db/redis'
import { describeCorridorReadiness } from '@/lib/payouts/registry'
import { isEncryptionConfigured } from '@/lib/crypto/secretbox'
import { isPhonePepperConfigured } from '@/lib/phone'
import { getScreeningProvider } from '@/lib/compliance/screening'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const database = isDbAvailable()
  const redis = getRedis() !== null
  const relayer = Boolean(process.env.RELAYER_PRIVATE_KEY && env.NEXT_PUBLIC_RELAYER_ADDRESS)
  const encryption = isEncryptionConfigured()
  const phonePepper = isPhonePepperConfigured()
  const cron = Boolean(process.env.CRON_SECRET)
  const notifications = Boolean(
    process.env.RESEND_API_KEY ||
    (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) ||
    (process.env.TWILIO_SID && process.env.TWILIO_AUTH_TOKEN),
  )

  const screening = getScreeningProvider()
  const corridors = describeCorridorReadiness(IS_PRODUCTION_CHAIN)
  const openCorridors = corridors.filter(c => c.open)
  const liveCorridors = openCorridors.filter(c => c.live)

  // A send can only be honoured end to end if every one of these holds.
  const canAcceptTransfers =
    database && relayer && encryption && phonePepper && notifications &&
    screening !== null && openCorridors.length > 0

  // On a production chain an open corridor must also be a LIVE one — a
  // simulated rail cannot settle real money.
  const canSettle = IS_PRODUCTION_CHAIN ? liveCorridors.length > 0 : openCorridors.length > 0

  const healthy = canAcceptTransfers && canSettle

  const body = {
    status: healthy ? 'ok' : 'unavailable',
    chainId: env.NEXT_PUBLIC_CHAIN_ID,
    productionChain: IS_PRODUCTION_CHAIN,
    services: {
      database: database ? 'connected' : 'MISSING DATABASE_URL',
      redis: redis ? 'connected' : 'missing UPSTASH_REDIS_REST_URL (rate limits are per-instance only)',
      relayer: relayer ? 'configured' : 'MISSING RELAYER_PRIVATE_KEY',
      secretsEncryption: encryption ? 'configured' : 'MISSING SECRETS_ENCRYPTION_KEY',
      phonePepper: phonePepper ? 'configured' : 'MISSING PHONE_HASH_PEPPER',
      notifications: notifications ? 'configured' : 'MISSING — recipients cannot receive claim codes',
      cron: cron ? 'protected' : 'MISSING CRON_SECRET — scheduled jobs are unauthenticated',
      screening: screening
        ? `${screening.id}${screening.isLive ? '' : ' (not a live sanctions source)'}`
        : 'MISSING SCREENING_PROVIDER — every send is blocked',
    },
    corridors,
    summary: {
      corridorsOpen: openCorridors.length,
      corridorsLive: liveCorridors.length,
      corridorsTotal: corridors.length,
      canAcceptTransfers,
      canSettle,
    },
    timestamp: new Date().toISOString(),
  }

  return NextResponse.json(body, {
    status: healthy ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  })
}
