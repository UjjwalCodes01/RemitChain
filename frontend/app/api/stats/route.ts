/**
 * app/api/stats/route.ts
 * GET /api/stats
 *
 * Judge dashboard: aggregate stats for the RemitChain demo.
 * Cached 30s in Redis. Falls back to DB query when Redis is unavailable.
 * Falls back to zeroed stats when DB is also unavailable.
 */

import { NextRequest, NextResponse } from 'next/server'
import { sql, eq } from 'drizzle-orm'
import { db, transfers } from '@/lib/db'
import { cacheGet, cacheSet } from '@/lib/db/redis'

export const dynamic = 'force-dynamic'

const CACHE_KEY = 'stats:agg'
const CACHE_TTL = 30 // seconds

interface StatsResponse {
  totalTransfers: number
  totalVolumeUSDC: number   // sum of amounts / 1e6
  claimedCount: number
  pendingCount: number
  cancelledCount: number
  smsDeliveredCount: number
  offrampCompletedCount: number
  activeCorridor: string | null
  cachedAt: string
  source: 'redis' | 'db' | 'empty'
}

export async function GET(_req: NextRequest) {
  // 1. Try Redis cache
  const cached = await cacheGet<StatsResponse>(CACHE_KEY)
  if (cached) {
    return NextResponse.json({ ...cached, source: 'redis' })
  }

  // 2. Compute from DB
  if (!db) {
    const empty: StatsResponse = {
      totalTransfers: 0,
      totalVolumeUSDC: 0,
      claimedCount: 0,
      pendingCount: 0,
      cancelledCount: 0,
      smsDeliveredCount: 0,
      offrampCompletedCount: 0,
      activeCorridor: null,
      cachedAt: new Date().toISOString(),
      source: 'empty',
    }
    return NextResponse.json(empty)
  }

  // Aggregate queries in parallel
  const [
    totalsResult,
    corridorResult,
  ] = await Promise.all([
    db.select({
      total: sql<number>`count(*)`,
      claimed: sql<number>`count(*) filter (where ${transfers.status} = 1)`,
      pending: sql<number>`count(*) filter (where ${transfers.status} = 0)`,
      cancelled: sql<number>`count(*) filter (where ${transfers.status} = 2)`,
      smsDelivered: sql<number>`count(*) filter (where ${transfers.smsStatus} = 'SENT')`,
      offrampDone: sql<number>`count(*) filter (where ${transfers.offrampStatus} = 'COMPLETED')`,
      // Sum of amounts (stored as text string of bigint in base units, 6 decimals)
      totalVolume: sql<string>`coalesce(sum(${transfers.amount}::numeric), 0)`,
    }).from(transfers),

    // Most active corridor
    db.select({
      corridor: transfers.corridor,
      count: sql<number>`count(*)`,
    })
      .from(transfers)
      .groupBy(transfers.corridor)
      .orderBy(sql`count(*) desc`)
      .limit(1),
  ])

  const row = totalsResult[0]
  const stats: StatsResponse = {
    totalTransfers: Number(row?.total ?? 0),
    totalVolumeUSDC: Number(row?.totalVolume ?? '0') / 1_000_000,
    claimedCount: Number(row?.claimed ?? 0),
    pendingCount: Number(row?.pending ?? 0),
    cancelledCount: Number(row?.cancelled ?? 0),
    smsDeliveredCount: Number(row?.smsDelivered ?? 0),
    offrampCompletedCount: Number(row?.offrampDone ?? 0),
    activeCorridor: corridorResult[0]?.corridor ?? null,
    cachedAt: new Date().toISOString(),
    source: 'db',
  }

  // Cache in Redis
  await cacheSet(CACHE_KEY, stats, CACHE_TTL)

  return NextResponse.json(stats, {
    headers: { 'Cache-Control': 's-maxage=30, stale-while-revalidate=60' },
  })
}
