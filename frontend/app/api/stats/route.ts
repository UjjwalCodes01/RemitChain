/**
 * app/api/stats/route.ts
 * GET /api/stats
 *
 * Judge dashboard stats — aggregate numbers for the RemitChain demo.
 * Cached 30s in Redis. Falls back to DB query when Redis is unavailable.
 *
 * Fields returned:
 *   - Core aggregates: total, volume, claimed, pending, cancelled
 *   - Funnel: sent → SMS → claimed → offramp (with conversion %)
 *   - Corridor breakdown: [{ corridor, count, volume }]
 *   - Fee savings vs Western Union
 *   - Recent 5 transfers (truncated — no PII)
 *   - Unique sender count
 */

import { NextRequest, NextResponse } from 'next/server'
import { sql, eq } from 'drizzle-orm'
import { db, transfers } from '@/lib/db'
import { cacheGet, cacheSet } from '@/lib/db/redis'

export const dynamic = 'force-dynamic'

const CACHE_KEY = 'stats:agg'
const CACHE_TTL = 30 // seconds
const WU_FEE_PCT = 0.045  // 4.5% Western Union fee
const OUR_FEE_PCT = 0.001 // 0.1% our fee

interface CorridorStat {
  corridor: string
  label: string
  count: number
  volumeUSDC: number
}

interface RecentTransfer {
  id: string          // truncated: 0x1234…abcd
  amount: string      // formatted QUSD
  corridor: string
  status: number
  statusLabel: string
  createdAt: number | null
}

interface StatsResponse {
  // Core
  totalTransfers: number
  totalVolumeUSDC: number
  claimedCount: number
  pendingCount: number
  cancelledCount: number
  uniqueSenders: number
  // Funnel
  smsDeliveredCount: number
  offrampCompletedCount: number
  claimRate: number        // claimedCount / totalTransfers %
  smsRate: number          // smsDeliveredCount / totalTransfers %
  offrampRate: number      // offrampCompletedCount / claimedCount %
  // Fee savings
  feeSavedVsWUUSDC: number // totalVolume * (WU_FEE_PCT - OUR_FEE_PCT)
  // Breakdown
  activeCorridor: string | null
  corridorBreakdown: CorridorStat[]
  recentTransfers: RecentTransfer[]
  // Meta
  cachedAt: string
  source: 'redis' | 'db' | 'empty'
}

const CORRIDOR_LABELS: Record<string, string> = {
  'ae-in':  'UAE → India',
  'us-mx':  'USA → Mexico',
  'uk-ng':  'UK → Nigeria',
  'sg-bd':  'Singapore → Bangladesh',
  'sa-pk':  'Saudi → Pakistan',
  '1': 'UAE → India',
  '2': 'USA → Mexico',
  '3': 'UK → Nigeria',
  '4': 'Singapore → Bangladesh',
  '5': 'Saudi → Pakistan',
}

const STATUS_LABELS: Record<number, string> = {
  0: 'Pending',
  1: 'Claimed',
  2: 'Cancelled',
}

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return Math.round((numerator / denominator) * 1000) / 10 // 1 decimal
}

export async function GET(_req: NextRequest) {
  // 1. Try Redis cache
  const cached = await cacheGet<StatsResponse>(CACHE_KEY)
  if (cached) {
    return NextResponse.json({ ...cached, source: 'redis' as const })
  }

  // 2. Empty if no DB
  if (!db) {
    const empty: StatsResponse = {
      totalTransfers: 0, totalVolumeUSDC: 0,
      claimedCount: 0, pendingCount: 0, cancelledCount: 0, uniqueSenders: 0,
      smsDeliveredCount: 0, offrampCompletedCount: 0,
      claimRate: 0, smsRate: 0, offrampRate: 0,
      feeSavedVsWUUSDC: 0,
      activeCorridor: null, corridorBreakdown: [], recentTransfers: [],
      cachedAt: new Date().toISOString(), source: 'empty',
    }
    return NextResponse.json(empty)
  }

  // 3. Parallel DB queries
  const [totalsResult, corridorResult, recentResult] = await Promise.all([
    // Main aggregates
    db.select({
      total:        sql<number>`count(*)::int`,
      claimed:      sql<number>`count(*) filter (where ${transfers.status} = 1)::int`,
      pending:      sql<number>`count(*) filter (where ${transfers.status} = 0)::int`,
      cancelled:    sql<number>`count(*) filter (where ${transfers.status} = 2)::int`,
      smsDelivered: sql<number>`count(*) filter (where ${transfers.smsStatus} = 'SENT')::int`,
      offrampDone:  sql<number>`count(*) filter (where ${transfers.offrampStatus} = 'COMPLETED')::int`,
      totalVolume:  sql<string>`coalesce(sum(${transfers.amount}::numeric), 0)::text`,
      uniqueSenders:sql<number>`count(distinct ${transfers.senderAddress})::int`,
    }).from(transfers),

    // Per-corridor breakdown
    db.select({
      corridor: transfers.corridor,
      count:    sql<number>`count(*)::int`,
      volume:   sql<string>`coalesce(sum(${transfers.amount}::numeric), 0)::text`,
    })
      .from(transfers)
      .groupBy(transfers.corridor)
      .orderBy(sql`sum(${transfers.amount}::numeric) desc`)
      .limit(10),

    // Recent 5 transfers (no PII — just id/amount/corridor/status)
    db.select({
      id:        transfers.id,
      amount:    transfers.amount,
      corridor:  transfers.corridor,
      status:    transfers.status,
      createdAt: transfers.createdAt,
    })
      .from(transfers)
      .orderBy(sql`${transfers.createdAt} desc`)
      .limit(5),
  ])

  const row = totalsResult[0]
  const totalTransfers   = Number(row?.total ?? 0)
  const claimedCount     = Number(row?.claimed ?? 0)
  const pendingCount     = Number(row?.pending ?? 0)
  const cancelledCount   = Number(row?.cancelled ?? 0)
  const smsDeliveredCount = Number(row?.smsDelivered ?? 0)
  const offrampCompleted = Number(row?.offrampDone ?? 0)
  const totalVolumeBase  = Number(row?.totalVolume ?? '0')
  const totalVolumeUSDC  = totalVolumeBase / 1_000_000
  const uniqueSenders    = Number(row?.uniqueSenders ?? 0)

  const corridorBreakdown: CorridorStat[] = corridorResult.map(c => ({
    corridor: c.corridor,
    label: CORRIDOR_LABELS[c.corridor] ?? c.corridor,
    count: Number(c.count),
    volumeUSDC: Number(c.volume) / 1_000_000,
  }))

  const recentTransfers: RecentTransfer[] = recentResult.map(t => ({
    id: t.id.slice(0, 6) + '…' + t.id.slice(-4),
    amount: (Number(t.amount) / 1_000_000).toFixed(2),
    corridor: CORRIDOR_LABELS[t.corridor] ?? t.corridor,
    status: t.status,
    statusLabel: STATUS_LABELS[t.status] ?? 'Unknown',
    createdAt: t.createdAt,
  }))

  const feeSavedVsWUUSDC = totalVolumeUSDC * (WU_FEE_PCT - OUR_FEE_PCT)

  const stats: StatsResponse = {
    totalTransfers,
    totalVolumeUSDC,
    claimedCount,
    pendingCount,
    cancelledCount,
    uniqueSenders,
    smsDeliveredCount,
    offrampCompletedCount: offrampCompleted,
    claimRate:   pct(claimedCount, totalTransfers),
    smsRate:     pct(smsDeliveredCount, totalTransfers),
    offrampRate: pct(offrampCompleted, claimedCount),
    feeSavedVsWUUSDC,
    activeCorridor: corridorBreakdown[0]?.corridor ?? null,
    corridorBreakdown,
    recentTransfers,
    cachedAt: new Date().toISOString(),
    source: 'db',
  }

  await cacheSet(CACHE_KEY, stats, CACHE_TTL)

  return NextResponse.json(stats, {
    headers: { 'Cache-Control': 's-maxage=30, stale-while-revalidate=60' },
  })
}
