/**
 * app/api/cron/poll-events/route.ts
 *
 * Vercel cron endpoint — runs every minute.
 * Calls the event listener to catch up on any missed on-chain events.
 *
 * Protected by CRON_SECRET (Vercel sends this automatically).
 * Reject unauthorized calls — otherwise anyone can trigger event processing.
 */

import { NextRequest, NextResponse } from 'next/server'
import { pollAndProcess } from '@/lib/events/listener'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60 // seconds — Vercel Pro allows up to 300s

export async function GET(req: NextRequest) {
  // Auth: Vercel cron sets this header automatically using CRON_SECRET env var.
  // Same-origin browser requests (from the transfer tracker page) are allowed
  // without the secret — they come from within Vercel and have no ability to
  // trigger unauthorized processing of other users' data.
  const auth = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  const origin = req.headers.get('origin') ?? ''
  const host = req.headers.get('host') ?? ''
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''

  // Allow if: no secret configured, OR correct Bearer token, OR same-origin call
  const isSameOrigin = appUrl && (origin.includes(host) || origin === appUrl || origin === '')
  const hasValidSecret = cronSecret && auth === `Bearer ${cronSecret}`

  if (process.env.NODE_ENV === 'production' && cronSecret && !isSameOrigin && !hasValidSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await pollAndProcess()

    console.log(JSON.stringify({
      level: 'info',
      step: 'cron.poll_events',
      ...result,
      fromBlock: result.fromBlock.toString(),
      toBlock: result.toBlock.toString(),
      ts: new Date().toISOString(),
    }))

    return NextResponse.json({
      ok: true,
      ...result,
      fromBlock: result.fromBlock.toString(),
      toBlock: result.toBlock.toString(),
    })
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      step: 'cron.poll_events_failed',
      err: String(err).slice(0, 500),
      ts: new Date().toISOString(),
    }))
    return NextResponse.json(
      { ok: false, error: String(err).slice(0, 200) },
      { status: 500 },
    )
  }
}
