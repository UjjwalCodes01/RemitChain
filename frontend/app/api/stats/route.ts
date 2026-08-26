/**
 * app/api/stats/route.ts
 * GET /api/stats
 *
 * Public aggregate statistics, computed from real transfer records.
 * Cached 30s in Redis. Falls back to a direct DB query when Redis is absent.
 *
 * Every number here is derived from the `transfers` and `payouts` tables. There
 * are no seeded or illustrative figures: on a fresh deployment this returns
 * zeros, which is the honest answer.
 *
 * Fields returned:
 *   - Core aggregates: total, volume, claimed, pending, cancelled
 *   - Funnel: sent → SMS → claimed → offramp (with conversion %)
 *   - Corridor breakdown: [{ corridor, count, volume }]
 *   - Fee saving vs the global average cost of remitting (see BENCHMARK_FEE_PCT)
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
/**
 * Benchmark cost of sending remittances, used for the "fees saved" comparison.
 *
 * 6.2% is the global average total cost of sending USD 200, published by the
 * World Bank's Remittance Prices Worldwide database. It is a citable,
 * industry-standard figure.
 *
 * It replaces a hard-coded `WU_FEE_PCT = 0.045` that the public /stats page
 * rendered as the assertion "WU charges 4.5%". Naming a specific competitor and
 * a specific rate, with no source and no corridor qualification, is a claim a
 * regulated money-services business has to be able to substantiate — and
 * Western Union's actual pricing varies widely by corridor, amount and payout
 * method, so no single figure would have been correct.
 *
 * Override with STATS_BENCHMARK_FEE_PCT if you have a corridor-specific source.
 */
const BENCHMARK_FEE_PCT = Number(process.env.STATS_BENCHMARK_FEE_PCT) || 0.062
const BENCHMARK_SOURCE = 'World Bank Remittance Prices Worldwide — global average, USD 200'

/** Our protocol fee: 10 bps, matching EscrowVault.feeBps. */
const OUR_FEE_PCT = 0.001

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
  /** totalVolume * (BENCHMARK_FEE_PCT - OUR_FEE_PCT) */
  feeSavedVsBenchmarkUSDC: number
  benchmarkFeePct: number
  benchmarkSource: string
  ourFeePct: number
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
      feeSavedVsBenchmarkUSDC: 0,
      benchmarkFeePct: BENCHMARK_FEE_PCT,
      benchmarkSource: BENCHMARK_SOURCE,
      ourFeePct: OUR_FEE_PCT,
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
      smsDelivered: sql<number>`count(*) filter (where ${transfers.notifyStatus} = 'SENT')::int`,
      // Payouts moved out of `transfers` into their own ledger, so settlement
      // is now counted from the source of truth rather than a mirrored column.
      offrampDone:  sql<number>`(select count(*) from payouts where status = 'PAID')::int`,
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

  const feeSavedVsBenchmarkUSDC = totalVolumeUSDC * (BENCHMARK_FEE_PCT - OUR_FEE_PCT)

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
    feeSavedVsBenchmarkUSDC,
    benchmarkFeePct: BENCHMARK_FEE_PCT,
    benchmarkSource: BENCHMARK_SOURCE,
    ourFeePct: OUR_FEE_PCT,
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
