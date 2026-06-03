'use client'

import { notFound } from 'next/navigation'
import { useEffect, useState, useCallback } from 'react'
import { motion } from 'motion/react'
import { FlaskConical, ExternalLink, RefreshCw, Send, Clock, CheckCircle2, AlertCircle, Copy, Loader2 } from 'lucide-react'
import Link from 'next/link'

// Hard-404 when demo mode is off — this check runs at render time.
// The build still includes this file (NEXT_PUBLIC_* is inlined at build time),
// so for production builds with DEMO_MODE=false this will always notFound().
function useDemoGuard() {
  if (process.env.NEXT_PUBLIC_DEMO_MODE !== 'true') {
    notFound()
  }
}

interface Transfer {
  id: string
  txHash: string | null
  recipientNickname: string | null
  recipientPhoneHash: string | null
  amount: string
  corridor: string
  status: number // 0=PENDING 1=CLAIMED 2=CANCELLED
  smsStatus: string
  createdAt: number
  claimedAt: number | null
  expiry: number | null
}

interface TransferWithOtp extends Transfer {
  demoOtp: string | null
  otpLoading: boolean
}

function statusLabel(s: number) {
  if (s === 1) return 'Claimed'
  if (s === 2) return 'Cancelled'
  return 'Pending'
}

function formatAmount(amount: string) {
  try { return (Number(amount) / 1_000_000).toFixed(2) } catch { return amount }
}

function corridorFlag(corridor: string) {
  const map: Record<string, string> = {
    'ae-in': '🇦🇪→🇮🇳', 'us-mx': '🇺🇸→🇲🇽', 'gb-ng': '🇬🇧→🇳🇬',
    'sa-pk': '🇸🇦→🇵🇰', 'sg-bd': '🇸🇬→🇧🇩',
  }
  return map[corridor] ?? corridor
}

export default function DemoPage() {
  useDemoGuard()

  const [transfers, setTransfers] = useState<TransferWithOtp[]>([])
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const fetchTransfers = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/transfers?address=all&demo=true')
      if (!res.ok) throw new Error('Failed')
      const data = await res.json()
      const rows: Transfer[] = data.transfers ?? []

      // For each transfer, fetch its demo OTP in parallel
      const withOtp: TransferWithOtp[] = rows.map(t => ({ ...t, demoOtp: null, otpLoading: t.status === 0 }))
      setTransfers(withOtp)
      setLastRefresh(new Date())

      // Fetch OTPs for pending transfers
      const pending = rows.filter(t => t.status === 0)
      await Promise.all(pending.map(async (t) => {
        try {
          const r = await fetch(`/api/transfers/${t.id}/demo-otp`)
          if (r.ok) {
            const { otp } = await r.json()
            setTransfers(prev =>
              prev.map(p => p.id === t.id ? { ...p, demoOtp: otp ?? null, otpLoading: false } : p)
            )
          } else {
            setTransfers(prev => prev.map(p => p.id === t.id ? { ...p, otpLoading: false } : p))
          }
        } catch {
          setTransfers(prev => prev.map(p => p.id === t.id ? { ...p, otpLoading: false } : p))
        }
      }))
    } catch (err) {
      console.error('[demo panel] fetch failed:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTransfers()
    const interval = setInterval(fetchTransfers, 5000)
    return () => clearInterval(interval)
  }, [fetchTransfers])

  const copyLink = async (txId: string, otp: string | null) => {
    const url = otp
      ? `${window.location.origin}/claim/${txId}?otp=${otp}`
      : `${window.location.origin}/claim/${txId}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(txId)
      setTimeout(() => setCopied(null), 2000)
    } catch { window.prompt('Copy:', url) }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ink)' }}>
      {/* Header */}
      <div
        className="sticky top-0 z-10 flex items-center gap-3 px-4 py-4 border-b"
        style={{ background: 'rgba(10,10,11,0.95)', backdropFilter: 'blur(16px)', borderColor: 'rgba(245,166,35,0.3)' }}
      >
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: 'rgba(245,166,35,0.15)', border: '1px solid rgba(245,166,35,0.4)' }}
        >
          <FlaskConical className="w-5 h-5" style={{ color: '#F5A623' }} />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="font-bold text-base" style={{ color: 'var(--color-text-primary)', letterSpacing: '-0.02em' }}>
            Demo Control Panel
          </h1>
          <p className="text-xs truncate" style={{ color: 'rgba(245,166,35,0.6)' }}>
            {lastRefresh ? `Last updated ${lastRefresh.toLocaleTimeString()}` : 'Loading…'}
          </p>
        </div>
        <button
          onClick={fetchTransfers}
          disabled={loading}
          className="w-9 h-9 rounded-xl flex items-center justify-center transition-opacity"
          style={{ background: 'var(--color-surface)', opacity: loading ? 0.5 : 1 }}
          aria-label="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} style={{ color: 'var(--color-text-secondary)' }} />
        </button>
        <Link
          href="/send"
          className="hidden sm:flex items-center gap-2 h-9 px-4 rounded-xl font-semibold text-sm"
          style={{ background: 'var(--color-mint)', color: 'var(--color-ink)' }}
        >
          <Send className="w-4 h-4" />
          New transfer
        </Link>
      </div>

      <main className="flex-1 px-4 pt-6 pb-20 max-w-2xl mx-auto w-full">
        {/* Info strip */}
        <div
          className="mb-6 p-4 rounded-xl text-sm"
          style={{ background: 'rgba(245,166,35,0.06)', border: '1px solid rgba(245,166,35,0.2)' }}
        >
          <p style={{ color: 'rgba(245,166,35,0.9)' }}>
            <span className="font-bold">Judge view — god mode.</span>
            {' '}You can see both sides of every transfer. OTPs are shown inline for pending transfers.
            Claim links include the OTP as a query param. Transfers auto-refresh every 5 seconds.
          </p>
        </div>

        {/* Quick actions */}
        <div className="flex gap-3 mb-6">
          <Link
            href="/send"
            className="flex-1 h-12 rounded-xl flex items-center justify-center gap-2 font-semibold text-sm"
            style={{ background: 'var(--color-mint)', color: 'var(--color-ink)' }}
          >
            <Send className="w-4 h-4" />
            Create transfer
          </Link>
          <Link
            href="/claim"
            className="flex-1 h-12 rounded-xl flex items-center justify-center gap-2 font-semibold text-sm border"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            <ExternalLink className="w-4 h-4" />
            Claim page
          </Link>
        </div>

        {/* Transfer list */}
        <div className="space-y-3">
          {loading && transfers.length === 0 ? (
            <div className="flex items-center justify-center h-32 gap-3" style={{ color: 'var(--color-text-tertiary)' }}>
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Loading transfers…</span>
            </div>
          ) : transfers.length === 0 ? (
            <div
              className="rounded-2xl border p-8 text-center"
              style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
            >
              <p className="font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>No transfers yet</p>
              <p className="text-sm mb-4" style={{ color: 'var(--color-text-tertiary)' }}>
                Create a transfer above to test the full send→claim flow.
              </p>
              <Link
                href="/send"
                className="inline-flex items-center gap-1 text-sm font-semibold"
                style={{ color: 'var(--color-mint)' }}
              >
                Start first transfer →
              </Link>
            </div>
          ) : (
            transfers.map((tx) => (
              <motion.div
                key={tx.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-2xl border overflow-hidden"
                style={{
                  background: 'var(--color-surface)',
                  borderColor: tx.status === 0
                    ? 'rgba(245,166,35,0.3)'
                    : tx.status === 1
                    ? 'var(--color-mint-glow)'
                    : 'var(--color-border)',
                }}
              >
                {/* Transfer header */}
                <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--color-border)' }}>
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                    style={{
                      background: tx.status === 1 ? 'var(--color-mint-dim)' : tx.status === 2 ? 'var(--color-coral-dim)' : 'rgba(245,166,35,0.12)',
                    }}
                  >
                    {tx.status === 1 ? (
                      <CheckCircle2 className="w-4 h-4" style={{ color: 'var(--color-mint)' }} />
                    ) : tx.status === 2 ? (
                      <AlertCircle className="w-4 h-4" style={{ color: 'var(--color-coral)' }} />
                    ) : (
                      <Clock className="w-4 h-4" style={{ color: '#F5A623' }} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold truncate" style={{ color: 'var(--color-text-primary)' }}>
                        {tx.recipientNickname ?? 'Recipient'} · {corridorFlag(tx.corridor)}
                      </span>
                      <span
                        className="text-xs px-2 py-0.5 rounded-full font-medium shrink-0"
                        style={{
                          background: tx.status === 1 ? 'var(--color-mint-dim)' : tx.status === 2 ? 'var(--color-coral-dim)' : 'rgba(245,166,35,0.12)',
                          color: tx.status === 1 ? 'var(--color-mint)' : tx.status === 2 ? 'var(--color-coral)' : '#F5A623',
                        }}
                      >
                        {statusLabel(tx.status)}
                      </span>
                    </div>
                    <p className="text-xs font-mono truncate" style={{ color: 'var(--color-text-tertiary)' }}>
                      {tx.id.slice(0, 20)}…
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold font-mono" style={{ color: 'var(--color-text-primary)' }}>
                      ${formatAmount(tx.amount)}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>QUSD</p>
                  </div>
                </div>

                {/* OTP + claim actions (pending only) */}
                {tx.status === 0 && (
                  <div className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <p className="text-xs mb-1" style={{ color: 'rgba(245,166,35,0.6)' }}>Demo OTP</p>
                        {tx.otpLoading ? (
                          <div className="flex items-center gap-1.5">
                            <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'rgba(245,166,35,0.5)' }} />
                            <span className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>Loading…</span>
                          </div>
                        ) : tx.demoOtp ? (
                          <p className="text-2xl font-black font-mono tracking-[0.2em]" style={{ color: 'var(--color-text-primary)' }}>
                            {tx.demoOtp}
                          </p>
                        ) : (
                          <p className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>OTP not available</p>
                        )}
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => copyLink(tx.id, tx.demoOtp)}
                          className="h-9 px-3 rounded-xl text-xs font-semibold flex items-center gap-1.5"
                          style={{
                            background: 'rgba(245,166,35,0.12)',
                            color: '#F5A623',
                            border: '1px solid rgba(245,166,35,0.3)',
                          }}
                        >
                          <Copy className="w-3.5 h-3.5" />
                          {copied === tx.id ? 'Copied!' : 'Copy'}
                        </button>
                        <a
                          href={tx.demoOtp
                            ? `/claim/${tx.id}?otp=${tx.demoOtp}`
                            : `/claim/${tx.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="h-9 px-3 rounded-xl text-xs font-semibold flex items-center gap-1.5"
                          style={{ background: '#F5A623', color: '#000' }}
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          Claim
                        </a>
                      </div>
                    </div>
                  </div>
                )}

                {/* Claimed footer */}
                {tx.status === 1 && tx.claimedAt && (
                  <div className="px-4 py-2" style={{ background: 'var(--color-mint-dim)' }}>
                    <p className="text-xs" style={{ color: 'var(--color-mint)' }}>
                      ✓ Claimed {new Date(tx.claimedAt).toLocaleTimeString()}
                    </p>
                  </div>
                )}
              </motion.div>
            ))
          )}
        </div>
      </main>
    </div>
  )
}
