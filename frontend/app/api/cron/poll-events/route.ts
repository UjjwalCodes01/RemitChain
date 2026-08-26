/**
 * app/api/cron/poll-events/route.ts
 *
 * Vercel cron endpoint — runs every minute.
 * Calls the event listener to catch up on any missed on-chain events.
 *
 * Protected by CRON_SECRET, which Vercel Cron sends automatically.
 *
 * The previous version treated an ABSENT Origin header as "same origin":
 *
 *     const isSameOrigin = appUrl && (origin.includes(host) || origin === appUrl || origin === '')
 *
 * A plain curl sends no Origin at all, so `origin === ''` matched and the
 * CRON_SECRET check was never reached — the endpoint was open to the internet.
 * Authentication is now delegated to `authenticateCron`, which has no
 * origin-based path at all.
 */

import { NextRequest, NextResponse } from 'next/server'
import { pollAndProcess } from '@/lib/events/listener'
import { authenticateCron } from '@/lib/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60 // seconds — Vercel Pro allows up to 300s

export async function GET(req: NextRequest) {
  const auth = authenticateCron(req)
  if (!auth.ok) {
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
