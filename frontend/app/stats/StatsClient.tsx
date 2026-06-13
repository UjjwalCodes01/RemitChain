'use client'

import { useEffect, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import {
  TrendingUp, Users, ArrowRightLeft, DollarSign,
  CheckCircle2, Clock, MessageSquare, Banknote,
  RefreshCw, Wifi, Shield, Database, Zap
} from 'lucide-react'
import Link from 'next/link'
import { activeChain } from '@/lib/chains'

// ── Types ─────────────────────────────────────────────────────────────────────

interface StatsResponse {
  totalTransfers: number
  totalVolumeUSDC: number
  claimedCount: number
  pendingCount: number
  cancelledCount: number
  uniqueSenders: number
  smsDeliveredCount: number
  offrampCompletedCount: number
  claimRate: number
  smsRate: number
  offrampRate: number
  feeSavedVsWUUSDC: number
  activeCorridor: string | null
  corridorBreakdown: { corridor: string; label: string; count: number; volumeUSDC: number }[]
  recentTransfers: { id: string; amount: string; corridor: string; status: number; statusLabel: string; createdAt: number | null }[]
  cachedAt: string
  source: 'redis' | 'db' | 'empty'
}

interface HealthResponse {
  status: 'ok' | 'degraded'
  services: Record<string, string>
}

// ── Animated counter ─────────────────────────────────────────────────────────

function AnimatedNumber({ value, decimals = 0, prefix = '', suffix = '' }: {
  value: number; decimals?: number; prefix?: string; suffix?: string
}) {
  const [display, setDisplay] = useState(0)

  useEffect(() => {
    const start = display
    const diff = value - start
    if (diff === 0) return
    const steps = 40
    let i = 0
    const id = setInterval(() => {
      i++
      const progress = 1 - Math.pow(1 - i / steps, 3) // ease-out cubic
      setDisplay(start + diff * progress)
      if (i >= steps) { setDisplay(value); clearInterval(id) }
    }, 16)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const formatted = decimals > 0
    ? display.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : Math.round(display).toLocaleString('en-US')

  return <span>{prefix}{formatted}{suffix}</span>
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, color = 'var(--color-mint)', delay = 0 }: {
  icon: React.ElementType; label: string; value: React.ReactNode; sub?: string; color?: string; delay?: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1], delay }}
      className="rounded-2xl p-5 border"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-center gap-2 mb-3">
        <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: `${color}20` }}>
          <Icon className="w-4 h-4" style={{ color }} />
        </div>
        <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--color-text-tertiary)' }}>
          {label}
        </span>
      </div>
      <div className="text-2xl font-bold tabular-nums" style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)' }}>
        {value}
      </div>
      {sub && <p className="text-xs mt-1" style={{ color: 'var(--color-text-tertiary)' }}>{sub}</p>}
    </motion.div>
  )
}

// ── Funnel bar ────────────────────────────────────────────────────────────────

function FunnelBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? (value / total) * 100 : 0
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between text-xs mb-1.5">
        <span style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
        <span className="font-mono font-semibold" style={{ color }}>
          {value.toLocaleString()} <span style={{ color: 'var(--color-text-tertiary)' }}>({pct.toFixed(0)}%)</span>
        </span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-surface-elevated)' }}>
        <motion.div
          className="h-full rounded-full"
          style={{ background: color }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, ease: [0.32, 0.72, 0, 1] }}
        />
      </div>
    </div>
  )
}

// ── Health pill ───────────────────────────────────────────────────────────────

function HealthPill({ label, status }: { label: string; status: string }) {
  const ok = status.startsWith('connected') || status.startsWith('configured') || status.startsWith('protected')
  const color = ok ? 'var(--color-mint)' : 'var(--color-warning)'
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <div className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      <span style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
    </div>
  )
}

// ── Main client component ─────────────────────────────────────────────────────

export function StatsClient() {
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const [sRes, hRes] = await Promise.all([
        fetch('/api/stats', { cache: 'no-store' }),
        fetch('/api/health', { cache: 'no-store' }),
      ])
      if (sRes.ok) { setStats(await sRes.json()); setLastRefresh(new Date()) }
      if (hRes.ok) setHealth(await hRes.json())
    } catch { /* silent — show stale data */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    fetchData()
    const id = setInterval(fetchData, 30_000)
    return () => clearInterval(id)
  }, [fetchData])

  const s = stats
  const maxCorridorVolume = s ? Math.max(...s.corridorBreakdown.map(c => c.volumeUSDC), 1) : 1

  return (
    <div className="min-h-screen" style={{ background: 'var(--color-ink)' }}>
      {/* Ambient glow */}
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        <div style={{
          position: 'absolute', top: '-10%', left: '50%', transform: 'translateX(-50%)',
          width: '80vw', height: '60vh',
          background: 'radial-gradient(ellipse, rgba(61,220,151,0.06) 0%, transparent 70%)',
          filter: 'blur(60px)',
        }} />
      </div>

      <div className="relative max-w-2xl mx-auto px-4 pt-16 pb-24">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="mb-10">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: 'var(--color-mint)', boxShadow: '0 0 20px rgba(61,220,151,0.4)' }}>
                <Zap className="w-4 h-4" style={{ color: 'var(--color-ink)' }} />
              </div>
              <span className="font-bold text-lg" style={{ color: 'var(--color-text-primary)' }}>RemitChain</span>
              <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: 'var(--color-mint-dim)', color: 'var(--color-mint)' }}>
                LIVE
              </span>
            </div>
            <button
              onClick={fetchData}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-tertiary)', background: 'var(--color-surface)' }}
              aria-label="Refresh stats"
            >
              <RefreshCw className="w-3 h-3" />
              {lastRefresh ? `${lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Refresh'}
            </button>
          </div>
          <h1 className="text-3xl font-bold mb-1" style={{ color: 'var(--color-text-primary)' }}>
            Live Statistics
          </h1>
          <p className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
            Phone-number-only payments · 0.1% flat fee · {activeChain.name} · Auto-refreshes every 30s
          </p>
        </motion.div>

        {loading && !stats ? (
          <div className="flex items-center justify-center py-24">
            <RefreshCw className="w-6 h-6 animate-spin" style={{ color: 'var(--color-text-tertiary)' }} />
          </div>
        ) : (
          <>
            {/* ── Core KPIs ── */}
            <div className="grid grid-cols-2 gap-3 mb-6">
              <StatCard icon={ArrowRightLeft} label="Total Transfers" delay={0}
                value={<AnimatedNumber value={s?.totalTransfers ?? 0} />}
                sub={`${s?.pendingCount ?? 0} pending · ${s?.cancelledCount ?? 0} cancelled`}
              />
              <StatCard icon={DollarSign} label="Volume (QUSD)" delay={0.05}
                value={<AnimatedNumber value={s?.totalVolumeUSDC ?? 0} decimals={2} prefix="$" />}
                sub={`Total sent on ${activeChain.name}`}
              />
              <StatCard icon={Users} label="Unique Senders" delay={0.1}
                value={<AnimatedNumber value={s?.uniqueSenders ?? 0} />}
                sub="Distinct wallet addresses"
              />
              <StatCard icon={TrendingUp} label="Saved vs WU" delay={0.15}
                value={<AnimatedNumber value={s?.feeSavedVsWUUSDC ?? 0} decimals={2} prefix="$" />}
                sub="4.4% less than 4.5% WU fee"
                color="var(--color-mint)"
              />
            </div>

            {/* ── Fee savings hero ── */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.2 }}
              className="rounded-2xl p-6 mb-6 border text-center"
              style={{ background: 'var(--color-mint-dim)', borderColor: 'var(--color-mint-glow)' }}
            >
              <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--color-mint)' }}>
                Cumulative fees saved vs Western Union
              </p>
              <div className="text-5xl font-bold tabular-nums mb-1" style={{ color: 'var(--color-mint)', fontFamily: 'var(--font-mono)' }}>
                <AnimatedNumber value={s?.feeSavedVsWUUSDC ?? 0} decimals={2} prefix="$" />
              </div>
              <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                WU charges 4.5% · We charge 0.1% · You keep 4.4%
              </p>
            </motion.div>

            {/* ── Funnel ── */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.25 }}
              className="rounded-2xl p-5 border mb-6"
              style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
            >
              <h2 className="text-xs font-semibold uppercase tracking-widest mb-5" style={{ color: 'var(--color-text-tertiary)' }}>
                Transfer Funnel
              </h2>
              <FunnelBar label="Sent" value={s?.totalTransfers ?? 0} total={s?.totalTransfers ?? 1} color="var(--color-text-secondary)" />
              <FunnelBar label="SMS Delivered" value={s?.smsDeliveredCount ?? 0} total={s?.totalTransfers ?? 1} color="var(--color-warning)" />
              <FunnelBar label="Claimed" value={s?.claimedCount ?? 0} total={s?.totalTransfers ?? 1} color="var(--color-mint)" />
              <FunnelBar label="Off-ramped" value={s?.offrampCompletedCount ?? 0} total={s?.totalTransfers ?? 1} color="#5FF0B0" />

              <div className="grid grid-cols-3 gap-3 mt-5 pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
                {[
                  { label: 'Claim rate', value: `${s?.claimRate ?? 0}%` },
                  { label: 'SMS rate', value: `${s?.smsRate ?? 0}%` },
                  { label: 'Offramp rate', value: `${s?.offrampRate ?? 0}%` },
                ].map(m => (
                  <div key={m.label} className="text-center">
                    <div className="text-lg font-bold" style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)' }}>{m.value}</div>
                    <div className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{m.label}</div>
                  </div>
                ))}
              </div>
            </motion.div>

            {/* ── Corridor breakdown ── */}
            {(s?.corridorBreakdown?.length ?? 0) > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.3 }}
                className="rounded-2xl p-5 border mb-6"
                style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
              >
                <h2 className="text-xs font-semibold uppercase tracking-widest mb-5" style={{ color: 'var(--color-text-tertiary)' }}>
                  Corridor Volume
                </h2>
                {s!.corridorBreakdown.map((c, i) => (
                  <div key={c.corridor} className="mb-4">
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span style={{ color: 'var(--color-text-secondary)' }}>{c.label}</span>
                      <span className="font-mono" style={{ color: 'var(--color-text-tertiary)' }}>
                        ${c.volumeUSDC.toFixed(0)} · {c.count} tx
                      </span>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-surface-elevated)' }}>
                      <motion.div
                        className="h-full rounded-full"
                        style={{ background: i === 0 ? 'var(--color-mint)' : 'var(--color-border-strong)' }}
                        initial={{ width: 0 }}
                        animate={{ width: `${(c.volumeUSDC / maxCorridorVolume) * 100}%` }}
                        transition={{ duration: 0.7, ease: [0.32, 0.72, 0, 1], delay: i * 0.05 }}
                      />
                    </div>
                  </div>
                ))}
              </motion.div>
            )}

            {/* ── Recent transfers ── */}
            {(s?.recentTransfers?.length ?? 0) > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.35 }}
                className="rounded-2xl overflow-hidden border mb-6"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <div className="px-5 py-4 border-b" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
                  <h2 className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--color-text-tertiary)' }}>
                    Recent Transfers
                  </h2>
                </div>
                {s!.recentTransfers.map((t, i) => (
                  <div key={i} className="flex items-center justify-between px-5 py-3.5 border-b last:border-b-0"
                    style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
                    <div>
                      <p className="text-xs font-mono" style={{ color: 'var(--color-text-tertiary)' }}>{t.id}</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>{t.corridor}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold font-mono" style={{ color: 'var(--color-text-primary)' }}>${t.amount}</p>
                      <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                        style={{
                          background: t.status === 1 ? 'var(--color-mint-dim)' : t.status === 0 ? 'rgba(245,166,35,0.12)' : 'var(--color-coral-dim)',
                          color: t.status === 1 ? 'var(--color-mint)' : t.status === 0 ? 'var(--color-warning)' : 'var(--color-coral)',
                        }}>
                        {t.statusLabel}
                      </span>
                    </div>
                  </div>
                ))}
              </motion.div>
            )}

            {/* ── System health ── */}
            {health && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.4 }}
                className="rounded-2xl p-5 border mb-6"
                style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
              >
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--color-text-tertiary)' }}>
                    System Health
                  </h2>
                  <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                    style={{
                      background: health.status === 'ok' ? 'var(--color-mint-dim)' : 'rgba(245,166,35,0.12)',
                      color: health.status === 'ok' ? 'var(--color-mint)' : 'var(--color-warning)',
                    }}>
                    {health.status.toUpperCase()}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(health.services).map(([key, val]) => (
                    <HealthPill key={key} label={key.charAt(0).toUpperCase() + key.slice(1)} status={val} />
                  ))}
                </div>
              </motion.div>
            )}

            {/* ── Footer ── */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}
              className="text-center text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
              <p>{activeChain.name} · Chain ID {activeChain.id} · <a
                href={activeChain.blockExplorers.default.url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
                style={{ color: 'var(--color-mint)' }}
              >View Explorer ↗</a></p>
              <p className="mt-1">Last updated: {lastRefresh?.toLocaleTimeString() ?? '—'} · Auto-refreshes every 30s</p>
              <div className="mt-4 flex items-center justify-center gap-4">
                <Link href="/" className="hover:opacity-80 transition-opacity" style={{ color: 'var(--color-mint)' }}>← App</Link>
                <Link href="/dashboard" className="hover:opacity-80 transition-opacity" style={{ color: 'var(--color-mint)' }}>Dashboard</Link>
                <Link href="/send" className="hover:opacity-80 transition-opacity" style={{ color: 'var(--color-mint)' }}>Send money</Link>
              </div>
            </motion.div>
          </>
        )}
      </div>
    </div>
  )
}
