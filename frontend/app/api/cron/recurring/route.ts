import { NextRequest, NextResponse } from 'next/server'

// Vercel Cron: runs daily at midnight UTC
// vercel.json: { "crons": [{ "path": "/api/cron/recurring", "schedule": "0 0 * * *" }] }

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  // Verify Vercel cron secret
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = Date.now()
  const upcoming24h = now + 24 * 60 * 60 * 1000

  // In production: query Vercel KV for schedules where nextRunAt <= upcoming24h
  // For hackathon demo: this endpoint is wired but the in-memory store won't persist
  // between serverless invocations — connect Vercel KV to fix.

  // TODO(production): Query KV and fire push notifications
  // const schedules = await kv.hvals('schedules')
  // const due = schedules.filter(s => s.active && s.nextRunAt <= upcoming24h)
  // for (const s of due) {
  //   await fetch('/api/push/send', { method: 'POST', body: JSON.stringify({
  //     address: s.ownerAddress, title: 'Reminder', body: `Send ${s.amount} QUSD to ${s.contactName}?`, url: '/send'
  //   })})
  // }

  return NextResponse.json({ ok: true, message: 'Cron ran — connect Vercel KV for persistence' })
}
