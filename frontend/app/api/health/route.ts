/**
 * app/api/health/route.ts
 * GET /api/health
 *
 * System health check — surfaces missing env vars and service status.
 * Safe to expose publicly (returns no secrets, only boolean availability flags).
 */

import { NextResponse } from 'next/server'
import { isDbAvailable } from '@/lib/db'
import { getRedis } from '@/lib/db/redis'

export const dynamic = 'force-dynamic'

export async function GET() {
  const dbOk = isDbAvailable()
  const redisOk = getRedis() !== null
  const relayerOk = !!(process.env.RELAYER_PRIVATE_KEY && process.env.NEXT_PUBLIC_RELAYER_ADDRESS)
  const twilioOk = !!(process.env.TWILIO_SID && process.env.TWILIO_AUTH_TOKEN)
  const razorpayOk = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
  const vapidOk = !!(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
  const cronOk = !!process.env.CRON_SECRET

  const allCritical = dbOk && relayerOk

  return NextResponse.json(
    {
      status: allCritical ? 'ok' : 'degraded',
      services: {
        database: dbOk ? 'connected' : 'missing DATABASE_URL',
        redis: redisOk ? 'connected' : 'missing UPSTASH_REDIS_REST_URL',
        relayer: relayerOk ? 'configured' : 'missing RELAYER_PRIVATE_KEY',
        twilio: twilioOk ? 'configured' : 'stub mode (add TWILIO_SID)',
        razorpay: razorpayOk ? 'configured' : 'stub mode (add RAZORPAY_KEY_ID)',
        vapid: vapidOk ? 'configured' : 'missing VAPID keys',
        cron: cronOk ? 'protected' : 'unprotected (add CRON_SECRET)',
      },
      timestamp: new Date().toISOString(),
    },
    {
      status: allCritical ? 200 : 200, // Always 200 — degraded is not an error
      headers: { 'Cache-Control': 'no-store' },
    },
  )
}
