'use client'

import { useConnect, useAccount, useBlockNumber, useChainId } from 'wagmi'
import { useRouter } from 'next/navigation'
import { useEffect, useState, useRef } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Wallet, AlertTriangle, ChevronRight, Zap } from 'lucide-react'
import Link from 'next/link'
import { useChainGuard } from '@/hooks/useChainGuard'
import { useQUSDBalance } from '@/hooks/useQUSDBalance'
import { Skeleton } from '@/components/ui/Skeleton'
import { NavBar } from '@/components/NavBar'
import { activeChain } from '@/lib/chains'
import { env } from '@/lib/env'
export default function ConnectPage() {
  const router = useRouter()
  const { address, isConnected } = useAccount()
  const { connectors, connect, isPending } = useConnect()
  const { wrongChain, switchChain, isSwitching } = useChainGuard()
  const { formatted: balance, isLoading: balanceLoading } = useQUSDBalance(address)
  const { data: blockNumber } = useBlockNumber({ watch: true })
  const chainId = useChainId()
  const [airdropState, setAirdropState] = useState<'idle' | 'pending' | 'done' | 'skipped'>('idle')
  const airdropAttempted = useRef(false)

  // Auto-fund: silently drip 100 QUSD when user connects with 0 balance
  useEffect(() => {
    if (
      isConnected &&
      !wrongChain &&
      address &&
      !balanceLoading &&
      balance === '0.00' &&
      !airdropAttempted.current
    ) {
      airdropAttempted.current = true
      setAirdropState('pending')
      fetch('/api/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      })
        .then(res => {
          if (res.ok || res.status === 429) {
            // 429 means already dripped — still fine
            setAirdropState('done')
          } else {
            setAirdropState('skipped')
          }
        })
        .catch(() => setAirdropState('skipped'))
    }
  }, [isConnected, wrongChain, address, balanceLoading, balance])

  // Redirect to dashboard once connected + on right chain
  useEffect(() => {
    if (isConnected && !wrongChain) {
      // Small delay so auto-fund toast is visible briefly
      const t = setTimeout(() => router.push('/dashboard'), airdropState === 'done' ? 1800 : 300)
      return () => clearTimeout(t)
    }
  }, [isConnected, wrongChain, router, airdropState])

  const injectedConnector = connectors.find(c => c.id === 'injected')

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: 'var(--color-ink)' }}
    >
      <NavBar />

      {/* Wrong-network full-screen takeover */}
      <AnimatePresence>
        {isConnected && wrongChain && (
          <motion.div
            key="wrong-network"
            className="fixed inset-0 flex flex-col items-center justify-center z-[var(--z-modal)] px-4 text-center"
            style={{ background: 'rgba(10,10,11,0.96)', backdropFilter: 'blur(20px)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="wrong-network-heading"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 25, delay: 0.1 }}
              className="flex flex-col items-center gap-6 max-w-sm"
            >
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center"
                style={{ background: 'var(--color-coral-dim)', border: '1px solid var(--color-coral)' }}
              >
                <AlertTriangle
                  className="w-8 h-8"
                  style={{ color: 'var(--color-coral)' }}
                  aria-hidden
                />
              </div>

              <div>
                <h2
                  id="wrong-network-heading"
                  className="text-2xl font-bold mb-2"
                  style={{ letterSpacing: '-0.03em' }}
                >
                  Wrong network
                </h2>
                <p style={{ color: 'var(--color-text-secondary)' }}>
                  You&apos;re connected to chain {chainId}. RemitChain runs on{' '}
                  <strong style={{ color: 'var(--color-text-primary)' }}>
                    {activeChain.name}
                  </strong>{' '}
                  (chain {activeChain.id}).
                </p>
              </div>

              <button
                onClick={switchChain}
                disabled={isSwitching}
                className="press-scale w-full h-14 rounded-xl font-semibold text-base transition-all"
                style={{
                  background: 'var(--color-mint)',
                  color: 'var(--color-ink)',
                  boxShadow: '0 0 40px rgba(61,220,151,0.35)',
                }}
                aria-label={`Switch to ${activeChain.name}`}
              >
                {isSwitching ? 'Switching…' : `Switch to ${activeChain.name}`}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Connect form */}
      <main
        id="connect-main"
        className="flex flex-1 items-center justify-center pt-24 pb-12 px-4"
        aria-labelledby="connect-heading"
      >
        <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
          {/* Left: wallet selector */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1] }}
          >
            <h1
              id="connect-heading"
              className="text-3xl font-bold mb-2"
              style={{ letterSpacing: '-0.03em' }}
            >
              Connect to RemitChain
            </h1>
            <p className="mb-8" style={{ color: 'var(--color-text-secondary)' }}>
              Your wallet signs transactions. Recipients never need one.
            </p>

            <div className="space-y-3">
              {/* QIE Wallet / Injected */}
              {injectedConnector && (
                <WalletButton
                  id="connect-qie-wallet"
                  label="QIE Wallet"
                  description="Use your browser extension or QIE mobile app"
                  icon="🔑"
                  isLoading={isPending}
                  onClick={() => connect({ connector: injectedConnector })}
                />
              )}

              {/* Fallback if no injected */}
              {!injectedConnector && (
                <div
                  className="rounded-xl p-5 border text-sm"
                  style={{
                    borderColor: 'var(--color-border)',
                    background: 'var(--color-surface)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  <Wallet className="w-5 h-5 mb-2" style={{ color: 'var(--color-text-tertiary)' }} aria-hidden />
                  No wallet extension detected.{' '}
                  <a
                    href="https://qie.digital"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                    style={{ color: 'var(--color-mint)' }}
                  >
                    Install QIE Wallet
                  </a>{' '}
                  to continue.
                </div>
              )}
            </div>

            <p
              className="text-xs mt-6 max-w-xs"
              style={{ color: 'var(--color-text-tertiary)' }}
            >
              By connecting you agree to the Terms of Service.
            </p>
          </motion.div>

          {/* Right: live status panel */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.32, 0.72, 0, 1], delay: 0.1 }}
            className="rounded-2xl p-6 border"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-border)',
            }}
            aria-label="Network status"
          >
            <h2
              className="text-sm font-semibold uppercase tracking-widest mb-6"
              style={{ color: 'var(--color-text-tertiary)' }}
            >
              Network status
            </h2>

            <div className="space-y-5">
              {/* Chain status */}
              <StatusRow label="Chain">
                <div className="flex items-center gap-2">
                  <span className="glow-dot" aria-hidden />
                  <span
                    className="text-sm font-medium"
                    style={{ color: 'var(--color-text-primary)' }}
                  >
                    {activeChain.name}
                  </span>
                  <span
                    className="text-xs font-mono"
                    style={{ color: 'var(--color-text-tertiary)' }}
                  >
                    #{activeChain.id}
                  </span>
                </div>
              </StatusRow>

              {/* Block height */}
              <StatusRow label="Block">
                <AnimatePresence mode="popLayout">
                  <motion.span
                    key={blockNumber?.toString()}
                    className="text-sm font-mono tabular-nums"
                    style={{ color: 'var(--color-mint)' }}
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                    transition={{ duration: 0.2 }}
                  >
                    {blockNumber ? `#${blockNumber.toLocaleString()}` : '—'}
                  </motion.span>
                </AnimatePresence>
              </StatusRow>

              {/* RPC endpoint */}
              <StatusRow label="RPC">
                <span
                  className="text-xs font-mono truncate max-w-[160px]"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {env.NEXT_PUBLIC_RPC_URL.replace('https://', '')}
                </span>
              </StatusRow>

              {/* QUSD balance (shown after connect) */}
              <StatusRow label="QUSD Balance">
                {isConnected ? (
                  balanceLoading ? (
                    <Skeleton height={18} width={80} />
                  ) : (
                    <span
                      className="text-sm font-mono tabular-nums font-bold"
                      style={{ color: 'var(--color-text-primary)' }}
                    >
                      {balance} QUSD
                    </span>
                  )
                ) : (
                  <span style={{ color: 'var(--color-text-tertiary)', fontSize: '13px' }}>
                    Connect first
                  </span>
                )}
              </StatusRow>
              {isConnected && !balanceLoading && balance === '0.00' && (
                <Link href="/faucet"
                  className="mt-3 flex items-center justify-center gap-2 h-10 rounded-xl text-sm font-semibold border w-full"
                  style={{ background: 'var(--color-mint-dim)', borderColor: 'var(--color-mint-glow)', color: 'var(--color-mint)' }}>
                  Get 100 free test QUSD →
                </Link>
              )}
            </div>
          </motion.div>
        </div>
      </main>

      {/* Auto-fund toast */}
      <AnimatePresence>
        {(airdropState === 'pending' || airdropState === 'done') && (
          <motion.div
            key="airdrop-toast"
            initial={{ opacity: 0, y: 24, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-5 py-3 rounded-2xl border shadow-xl"
            style={{
              background: 'var(--color-surface)',
              borderColor: airdropState === 'done' ? 'var(--color-mint-glow)' : 'var(--color-border)',
              boxShadow: airdropState === 'done' ? '0 0 30px rgba(61,220,151,0.2)' : 'none',
            }}
            role="status"
            aria-live="polite"
          >
            <div
              className="w-7 h-7 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: 'var(--color-mint-dim)' }}
            >
              {airdropState === 'pending' ? (
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                >
                  <Zap className="w-3.5 h-3.5" style={{ color: 'var(--color-mint)' }} />
                </motion.div>
              ) : (
                <Zap className="w-3.5 h-3.5" style={{ color: 'var(--color-mint)' }} />
              )}
            </div>
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                {airdropState === 'pending' ? 'Funding your wallet…' : '100 QUSD added ✨'}
              </p>
              <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                {airdropState === 'pending' ? 'Getting you test QUSD to start' : 'Redirecting to dashboard'}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ── Sub-components ─────────────────────────────────────────────── */

interface WalletButtonProps {
  id: string
  label: string
  description: string
  icon: string
  isLoading: boolean
  onClick: () => void
}

function WalletButton({ id, label, description, icon, isLoading, onClick }: WalletButtonProps) {
  return (
    <motion.button
      id={id}
      whileTap={{ scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 400, damping: 20 }}
      onClick={onClick}
      disabled={isLoading}
      className="w-full flex items-center justify-between rounded-xl p-5 border text-left transition-colors group"
      style={{
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border-strong)',
      }}
      aria-label={`Connect using ${label}`}
      onMouseEnter={e => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-mint)'
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-border-strong)'
      }}
    >
      <div className="flex items-center gap-4">
        <span className="text-2xl" aria-hidden>{icon}</span>
        <div>
          <p className="font-semibold text-sm" style={{ color: 'var(--color-text-primary)' }}>
            {label}
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
            {description}
          </p>
        </div>
      </div>
      <ChevronRight
        className="w-5 h-5 shrink-0 transition-transform group-hover:translate-x-1"
        style={{ color: 'var(--color-text-tertiary)' }}
        aria-hidden
      />
    </motion.button>
  )
}

interface StatusRowProps {
  label: string
  children: React.ReactNode
}

function StatusRow({ label, children }: StatusRowProps) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
        {label}
      </span>
      {children}
    </div>
  )
}
