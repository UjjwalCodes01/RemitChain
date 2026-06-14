'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Droplets, CheckCircle2, AlertCircle, Loader2, ExternalLink, Zap } from 'lucide-react'
import { useAccount } from 'wagmi'
import Link from 'next/link'
import { NavBar } from '@/components/NavBar'
import type { Metadata } from 'next'

export default function FaucetPage() {
  const { address: connectedAddress } = useAccount()
  const [inputAddress, setInputAddress] = useState(connectedAddress ?? '')
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'ratelimit' | 'error'>('idle')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState('')

  // Keep input synced when wallet connects
  if (connectedAddress && !inputAddress) setInputAddress(connectedAddress)

  const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(inputAddress.trim())

  const handleDrip = async () => {
    if (!isValidAddress || state === 'loading') return
    setState('loading')
    setErrorMsg('')

    try {
      const res = await fetch('/api/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: inputAddress.trim() }),
      })
      const data = await res.json() as { success?: boolean; txHash?: string; error?: string; rateLimited?: boolean }

      if (res.status === 429 || data.rateLimited) {
        setState('ratelimit')
        setErrorMsg(data.error ?? 'Rate limited')
        return
      }
      if (!res.ok) {
        setState('error')
        setErrorMsg(data.error ?? 'Faucet request failed')
        return
      }
      setTxHash(data.txHash ?? null)
      setState('success')
    } catch {
      setState('error')
      setErrorMsg('Network error. Check your connection.')
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ink)' }}>
      <NavBar />

      {/* Ambient glow */}
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        <div style={{
          position: 'absolute', top: '20%', left: '50%', transform: 'translateX(-50%)',
          width: '60vw', height: '50vh',
          background: 'radial-gradient(ellipse, rgba(61,220,151,0.08) 0%, transparent 70%)',
          filter: 'blur(60px)',
        }} />
      </div>

      <main className="relative flex-1 flex flex-col items-center justify-center px-4 pt-24 pb-16">
        <motion.div
          className="w-full max-w-sm mx-auto text-center"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
        >
          {/* Icon */}
          <div className="w-20 h-20 rounded-3xl flex items-center justify-center mx-auto mb-6"
            style={{ background: 'var(--color-mint-dim)', border: '1px solid var(--color-mint-glow)' }}>
            <Droplets className="w-10 h-10" style={{ color: 'var(--color-mint)' }} />
          </div>

          <h1 className="text-3xl font-bold mb-2" style={{ color: 'var(--color-text-primary)' }}>
            Testnet Faucet
          </h1>
          <p className="text-sm mb-8" style={{ color: 'var(--color-text-secondary)' }}>
            Get <span className="font-semibold" style={{ color: 'var(--color-mint)' }}>100 test QUSD</span> to try RemitChain.
            <br />One drip per wallet per 24 hours.
          </p>

          <AnimatePresence mode="wait">
            {state === 'success' ? (
              <motion.div key="success"
                className="p-6 rounded-2xl border text-center"
                style={{ background: 'var(--color-mint-dim)', borderColor: 'var(--color-mint-glow)' }}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
              >
                <CheckCircle2 className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--color-mint)' }} />
                <h2 className="text-xl font-bold mb-1" style={{ color: 'var(--color-text-primary)' }}>100 QUSD sent!</h2>
                <p className="text-sm mb-4" style={{ color: 'var(--color-text-secondary)' }}>
                  It&apos;ll appear in your wallet in ~10 seconds.
                </p>
                {txHash && (
                  <a href={`https://mainnet.qiescan.io/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
                    className="flex items-center justify-center gap-1.5 text-xs mb-4"
                    style={{ color: 'var(--color-mint)' }}>
                    View on QIEScan <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                <div className="flex flex-col gap-3">
                  <Link href="/send"
                    className="h-12 rounded-xl font-semibold flex items-center justify-center gap-2"
                    style={{ background: 'var(--color-mint)', color: 'var(--color-ink)' }}>
                    <Zap className="w-4 h-4" />
                    Send money now
                  </Link>
                  <Link href="/dashboard"
                    className="h-12 rounded-xl font-semibold flex items-center justify-center"
                    style={{ background: 'var(--color-surface)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}>
                    Go to dashboard
                  </Link>
                </div>
              </motion.div>

            ) : state === 'ratelimit' ? (
              <motion.div key="ratelimit"
                className="p-6 rounded-2xl border"
                style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <AlertCircle className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--color-warning)' }} />
                <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--color-text-primary)' }}>Already dripped</h2>
                <p className="text-sm mb-4" style={{ color: 'var(--color-text-secondary)' }}>{errorMsg}</p>
                <Link href="/dashboard"
                  className="h-12 rounded-xl font-semibold flex items-center justify-center"
                  style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }}>
                  Back to dashboard
                </Link>
              </motion.div>

            ) : (
              <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                {/* Address input */}
                <div className="mb-4 text-left">
                  <label className="block text-xs font-semibold uppercase tracking-widest mb-2"
                    style={{ color: 'var(--color-text-tertiary)' }}>
                    Wallet Address
                  </label>
                  <input
                    type="text"
                    value={inputAddress}
                    onChange={e => setInputAddress(e.target.value)}
                    placeholder="0x..."
                    className="w-full px-4 h-14 rounded-xl border outline-none text-sm font-mono"
                    style={{
                      background: 'var(--color-surface)',
                      borderColor: isValidAddress ? 'var(--color-mint)' : 'var(--color-border)',
                      color: 'var(--color-text-primary)',
                    }}
                    aria-label="Wallet address to receive test QUSD"
                  />
                  {connectedAddress && inputAddress !== connectedAddress && (
                    <button className="text-xs mt-1.5 font-semibold" style={{ color: 'var(--color-mint)' }}
                      onClick={() => setInputAddress(connectedAddress)}>
                      Use connected wallet
                    </button>
                  )}
                </div>

                {/* What you&apos;ll receive */}
                <div className="p-4 rounded-xl border mb-4 text-left"
                  style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
                  <div className="flex items-center justify-between text-sm">
                    <span style={{ color: 'var(--color-text-secondary)' }}>You&apos;ll receive</span>
                    <span className="font-bold font-mono" style={{ color: 'var(--color-mint)' }}>100.00 QUSD</span>
                  </div>
                  <div className="flex items-center justify-between text-xs mt-1">
                    <span style={{ color: 'var(--color-text-tertiary)' }}>Cooldown</span>
                    <span style={{ color: 'var(--color-text-tertiary)' }}>24 hours</span>
                  </div>
                </div>

                {/* Error */}
                <AnimatePresence>
                  {state === 'error' && (
                    <motion.div
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="p-3 rounded-xl flex items-center gap-2 mb-4 text-left"
                      style={{ background: 'var(--color-coral-dim)', borderColor: 'var(--color-coral)' }}
                    >
                      <AlertCircle className="w-4 h-4 shrink-0" style={{ color: 'var(--color-coral)' }} />
                      <p className="text-sm" style={{ color: 'var(--color-coral)' }}>{errorMsg}</p>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* CTA */}
                <button
                  disabled={!isValidAddress || state === 'loading'}
                  onClick={handleDrip}
                  className="w-full h-14 rounded-xl font-semibold flex items-center justify-center gap-2 transition-all"
                  style={{
                    background: isValidAddress ? 'var(--color-mint)' : 'var(--color-surface-elevated)',
                    color: isValidAddress ? 'var(--color-ink)' : 'var(--color-text-tertiary)',
                    boxShadow: isValidAddress ? '0 0 32px rgba(61,220,151,0.25)' : 'none',
                    cursor: isValidAddress ? 'pointer' : 'not-allowed',
                  }}
                  aria-label="Request 100 test QUSD"
                >
                  {state === 'loading' ? (
                    <><Loader2 className="w-5 h-5 animate-spin" />Sending...</>
                  ) : (
                    <><Droplets className="w-5 h-5" />Get 100 Test QUSD</>
                  )}
                </button>

                <p className="text-xs mt-4" style={{ color: 'var(--color-text-tertiary)' }}>
                  Built on QIE Mainnet. QUSD is a demo stablecoin for the hackathon.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </main>
    </div>
  )
}
