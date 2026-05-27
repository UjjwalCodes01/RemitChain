'use client'

import { useAccount } from 'wagmi'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { motion } from 'motion/react'
import { ArrowRight, Send } from 'lucide-react'
import Link from 'next/link'
import { useQUSDBalance } from '@/hooks/useQUSDBalance'
import { useKYCStatus } from '@/hooks/useKYCStatus'
import { KYCBadge } from '@/components/ui/KYCBadge'
import { Skeleton } from '@/components/ui/Skeleton'
import { NavBar } from '@/components/NavBar'

export default function DashboardPage() {
  const router = useRouter()
  const { address, isConnected } = useAccount()
  const { formatted: balance, raw: balanceRaw, isLoading: balanceLoading } = useQUSDBalance(address)
  const { tier, isLoading: kycLoading, tierLabel, dailyLimit } = useKYCStatus(address)

  // Guard: must be connected
  useEffect(() => {
    if (!isConnected) {
      router.push('/connect')
    }
  }, [isConnected, router])

  if (!isConnected) return null

  // Balance in USD (QUSD is 1:1)
  const usdValue = balanceRaw ? Number(balanceRaw) / 1_000_000 : 0

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: 'var(--color-ink)' }}
    >
      <NavBar />

      <main
        id="dashboard-main"
        className="flex-1 max-w-2xl mx-auto w-full px-4 pt-28 pb-16"
        aria-labelledby="dashboard-heading"
      >
        {/* ── Balance header ── */}
        <motion.div
          className="mb-8"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1] }}
        >
          <p
            className="text-xs uppercase tracking-widest font-semibold mb-2"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            QUSD Balance
          </p>

          {balanceLoading ? (
            <div className="space-y-2">
              <Skeleton height={56} width="60%" />
              <Skeleton height={20} width="30%" />
            </div>
          ) : (
            <>
              <h1
                id="dashboard-heading"
                className="text-[clamp(2.5rem,8vw,4rem)] font-bold leading-none tabular-nums"
                style={{
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '-0.04em',
                  color: 'var(--color-text-primary)',
                }}
                aria-label={`Balance: ${balance} QUSD`}
              >
                {balance}
              </h1>
              <p
                className="text-base mt-1 tabular-nums"
                style={{ color: 'var(--color-text-tertiary)' }}
              >
                ≈ ${usdValue.toFixed(2)} USD
              </p>
            </>
          )}
        </motion.div>

        {/* ── KYC Badge ── */}
        <motion.div
          className="mb-8"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1], delay: 0.05 }}
        >
          <KYCBadge
            tier={tier}
            isLoading={kycLoading}
            showUpgradeCTA={tier < 2}
          />
          {!kycLoading && (
            <p
              className="text-xs mt-2"
              style={{ color: 'var(--color-text-tertiary)' }}
            >
              {tierLabel} · {dailyLimit}
            </p>
          )}
        </motion.div>

        {/* ── Primary action: Send money ── */}
        <motion.div
          className="mb-6"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1], delay: 0.1 }}
        >
          <Link
            href="/send"
            id="dashboard-send"
            className="
              press-scale flex items-center justify-between w-full rounded-2xl p-6
              border transition-all group
            "
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-border-strong)',
              textDecoration: 'none',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLAnchorElement
              el.style.borderColor = 'var(--color-mint)'
              el.style.boxShadow = 'var(--shadow-mint)'
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLAnchorElement
              el.style.borderColor = 'var(--color-border-strong)'
              el.style.boxShadow = 'none'
            }}
            aria-label="Send money — go to send screen"
          >
            <div className="flex items-center gap-4">
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: 'var(--color-mint-dim)', border: '1px solid var(--color-mint-glow)' }}
                aria-hidden
              >
                <Send className="w-5 h-5" style={{ color: 'var(--color-mint)' }} />
              </div>
              <div>
                <p
                  className="font-semibold text-base"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  Send money
                </p>
                <p
                  className="text-sm"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  Any corridor · 0.1% fee · OTP delivery in &lt;3s
                </p>
              </div>
            </div>
            <ArrowRight
              className="w-5 h-5 shrink-0 transition-transform group-hover:translate-x-1"
              style={{ color: 'var(--color-text-tertiary)' }}
              aria-hidden
            />
          </Link>
        </motion.div>

        {/* ── Recent transfers ── */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1], delay: 0.15 }}
        >
          <div className="flex items-center justify-between mb-4">
            <h2
              className="text-sm font-semibold uppercase tracking-widest"
              style={{ color: 'var(--color-text-tertiary)' }}
            >
              Recent transfers
            </h2>
          </div>

          {/* Beautiful empty state */}
          <EmptyTransfersState />
        </motion.div>
      </main>
    </div>
  )
}

function EmptyTransfersState() {
  return (
    <div
      className="rounded-2xl border overflow-hidden"
      style={{ borderColor: 'var(--color-border)' }}
    >
      {/* Faded placeholder row */}
      <div
        className="p-5 border-b"
        style={{
          borderColor: 'var(--color-border)',
          opacity: 0.35,
          pointerEvents: 'none',
          userSelect: 'none',
        }}
        aria-hidden="true"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-full skeleton"
              style={{ flexShrink: 0 }}
            />
            <div className="space-y-2">
              <div className="skeleton h-3.5 w-28 rounded" />
              <div className="skeleton h-3 w-20 rounded" />
            </div>
          </div>
          <div className="space-y-2 text-right">
            <div className="skeleton h-3.5 w-16 rounded ml-auto" />
            <div className="skeleton h-3 w-12 rounded ml-auto" />
          </div>
        </div>
      </div>

      {/* Invitation copy */}
      <div className="p-6 text-center">
        <p
          className="font-medium mb-1"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          No transfers yet
        </p>
        <p
          className="text-sm"
          style={{ color: 'var(--color-text-tertiary)' }}
        >
          Your first transfer will appear here the moment it lands on-chain.
          <br />
          Every transaction, verified. Every penny, accounted for.
        </p>
        <Link
          href="/send"
          className="inline-flex items-center gap-1 mt-4 text-sm font-semibold transition-opacity hover:opacity-80"
          style={{ color: 'var(--color-mint)' }}
          aria-label="Start your first transfer"
        >
          Start your first transfer
          <ArrowRight className="w-4 h-4" aria-hidden />
        </Link>
      </div>
    </div>
  )
}
