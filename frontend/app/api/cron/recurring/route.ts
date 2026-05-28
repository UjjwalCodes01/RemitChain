/**
 * app/api/cron/recurring/route.ts
 *
 * Daily recurring transfer reminder cron — runs at 09:00 UTC.
 * Migrated from TODO stub to real DB query.
 *
 * Finds all ACTIVE schedules where nextRunAt <= now + 24h
 * and sends a push notification to the sender.
 */

import { NextRequest, NextResponse } from 'next/server'
import { lte, eq, and } from 'drizzle-orm'
import { db, schedules } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (process.env.NODE_ENV === 'production' && cronSecret) {
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  if (!db) {
    return NextResponse.json({ ok: true, message: 'DB not configured — add DATABASE_URL' })
  }

  const upcoming24h = Date.now() + 24 * 60 * 60 * 1000

  const dueSchedules = await db
    .select()
    .from(schedules)
    .where(and(
      eq(schedules.status, 'ACTIVE'),
      lte(schedules.nextRunAt, upcoming24h),
    ))

  let notified = 0

  for (const schedule of dueSchedules) {
    try {
      // Trigger a push notification to the sender (non-blocking)
      const baseUrl =
        process.env.NEXT_PUBLIC_APP_URL ??
        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

      await fetch(`${baseUrl}/api/push/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: schedule.senderAddress,
          title: '🔁 Scheduled Transfer Due',
          body: `Send ${schedule.amount} QUSD to ${schedule.recipientNickname ?? 'recipient'}?`,
          url: '/send',
        }),
      })

      // Advance nextRunAt based on frequency
      let nextRunAt = schedule.nextRunAt
      if (schedule.frequency === 'WEEKLY') {
        nextRunAt += 7 * 24 * 60 * 60 * 1000
      } else if (schedule.frequency === 'MONTHLY') {
        const next = new Date(nextRunAt)
        next.setMonth(next.getMonth() + 1)
        nextRunAt = next.getTime()
      }

      await db
        .update(schedules)
        .set({ nextRunAt, lastRunAt: Date.now() })
        .where(eq(schedules.id, schedule.id))

      notified++
    } catch (err) {
      console.error('[recurring] Failed to notify schedule', schedule.id, err)
    }
  }

  return NextResponse.json({
    ok: true,
    dueCount: dueSchedules.length,
    notified,
    ts: new Date().toISOString(),
  })
}
