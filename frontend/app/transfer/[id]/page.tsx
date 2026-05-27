'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { motion, AnimatePresence } from 'motion/react'
import { CheckCircle2, Clock, Share2, Loader2, ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { usePublicClient, useReadContract } from 'wagmi'
import { REMITCHAIN_ADDRESS, RemitChainAbi } from '@/lib/contracts'

const STAGES = [
  { id: 'sent', label: 'Sent', sublabel: 'Transfer initiated on-chain' },
  { id: 'confirmed', label: 'Confirmed on chain', sublabel: '' },
  { id: 'notified', label: 'Recipient notified', sublabel: 'OTP delivered to sender' },
  { id: 'claimed', label: 'Claimed', sublabel: 'Funds released' },
] as const

type StageId = (typeof STAGES)[number]['id']

function stageIndex(id: StageId) {
  return STAGES.findIndex(s => s.id === id)
}

export default function TransferTrackerPage() {
  const params = useParams()
  const txId = typeof params.id === 'string' ? params.id : Array.isArray(params.id) ? params.id[0] : ''
  const transferId = (txId.startsWith('0x') ? txId : `0x${txId}`) as `0x${string}`

  const [currentStage, setCurrentStage] = useState<StageId>('sent')
  const [blockConfirms, setBlockConfirms] = useState(0)
  const [confettiLoaded, setConfettiLoaded] = useState(false)
  const publicClient = usePublicClient()

  const { data: transfer, refetch } = useReadContract({
    address: REMITCHAIN_ADDRESS,
    abi: RemitChainAbi,
    functionName: 'getTransfer',
    args: [transferId],
    query: {
      enabled: Boolean(transferId && transferId.length === 66),
      refetchInterval: currentStage !== 'claimed' ? 4000 : false,
    }
  })

  // Derive stage from transfer status
  useEffect(() => {
    if (!transfer) return
    if (transfer.status === 1) {
      setCurrentStage('claimed')
    } else if (transfer.status === 0) {
      // PENDING — advance through sent → confirmed → notified based on time
      const age = Date.now() / 1000 - Number(transfer.createdAt ?? 0)
      if (age > 30) setCurrentStage('notified')
      else if (age > 12) setCurrentStage('confirmed')
      else setCurrentStage('sent')
    }
  }, [transfer])

  // Block confirmation counter
  useEffect(() => {
    if (currentStage === 'claimed') return
    const interval = setInterval(async () => {
      if (!publicClient) return
      try {
        const block = await publicClient.getBlockNumber()
        setBlockConfirms(n => Math.min(n + 1, Number(block) % 12 + 1))
      } catch { /* ignore */ }
    }, 5000)
    return () => clearInterval(interval)
  }, [currentStage, publicClient])

  // Wake lock
  useEffect(() => {
    if (currentStage === 'claimed') return
    let lock: WakeLockSentinel | null = null
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(l => { lock = l }).catch(() => {})
    }
    return () => { lock?.release().catch(() => {}) }
  }, [currentStage])

  // Haptics on stage change
  useEffect(() => {
    if (currentStage === 'claimed') {
      if (navigator.vibrate) navigator.vibrate([10, 50, 10, 50, 80])
    } else {
      if (navigator.vibrate) navigator.vibrate(20)
    }
  }, [currentStage])

  // Confetti on claim
  useEffect(() => {
    if (currentStage !== 'claimed') return
    import('canvas-confetti').then(({ default: confetti }) => {
      setConfettiLoaded(true)
      confetti({ particleCount: 120, spread: 80, origin: { y: 0.6 }, colors: ['#3DDC97', '#5FF0B0', '#ffffff'] })
      setTimeout(() => confetti({ particleCount: 60, spread: 100, origin: { y: 0.5 }, colors: ['#3DDC97', '#FFD700'] }), 400)
    })
  }, [currentStage])

  // Watch for claim events
  useEffect(() => {
    if (!publicClient || currentStage === 'claimed') return
    const unwatch = publicClient.watchContractEvent({
      address: REMITCHAIN_ADDRESS,
      abi: RemitChainAbi,
      eventName: 'RemittanceClaimed',
      onLogs: (logs) => {
        const relevant = logs.find(l => {
          const args = l.args as { transferId?: string }
          return args.transferId === transferId
        })
        if (relevant) {
          setCurrentStage('claimed')
          refetch()
        }
      },
    })
    return () => unwatch()
  }, [publicClient, transferId, currentStage, refetch])

  const handleShare = async () => {
    const claimUrl = `${window.location.origin}/claim/${txId}`
    try {
      await navigator.share({ title: 'Your RemitChain transfer', text: 'Claim your money here:', url: claimUrl })
    } catch {
      await navigator.clipboard.writeText(claimUrl)
    }
  }

  const currentIdx = stageIndex(currentStage)

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ink)' }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-14 pb-4 sticky top-0 z-10"
        style={{ background: 'rgba(10,10,11,0.92)', backdropFilter: 'blur(20px)', borderBottom: '1px solid var(--color-border)' }}>
        <Link href="/dashboard" className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: 'var(--color-surface)' }} aria-label="Back to dashboard">
          <ArrowLeft className="w-5 h-5" style={{ color: 'var(--color-text-primary)' }} />
        </Link>
        <div className="flex-1">
          <h1 className="text-base font-bold" style={{ color: 'var(--color-text-primary)' }}>Transfer</h1>
          <p className="text-xs font-mono truncate" style={{ color: 'var(--color-text-tertiary)' }}>{txId.slice(0, 18)}…</p>
        </div>
        <button onClick={handleShare} className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: 'var(--color-surface)' }} aria-label="Share transfer link">
          <Share2 className="w-4 h-4" style={{ color: 'var(--color-text-secondary)' }} />
        </button>
      </div>

      <main className="flex-1 px-6 pt-10 pb-32">
        {/* Stepper */}
        <div className="relative">
          {STAGES.map((stage, idx) => {
            const done = idx < currentIdx
            const active = idx === currentIdx
            const upcoming = idx > currentIdx
            return (
              <div key={stage.id} className="flex gap-4 mb-8 last:mb-0">
                {/* Line + dot */}
                <div className="flex flex-col items-center">
                  <motion.div
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 z-10"
                    animate={{
                      background: done ? 'var(--color-mint)' : active ? 'var(--color-mint-dim)' : 'var(--color-surface)',
                      borderColor: done || active ? 'var(--color-mint)' : 'var(--color-border-strong)',
                    }}
                    transition={{ duration: 0.4 }}
                    style={{ border: '2px solid' }}
                  >
                    {done ? (
                      <CheckCircle2 className="w-4 h-4" style={{ color: 'var(--color-ink)' }} />
                    ) : active ? (
                      <motion.div
                        animate={{ scale: [1, 1.2, 1] }}
                        transition={{ repeat: Infinity, duration: 1.5 }}
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ background: 'var(--color-mint)' }}
                      />
                    ) : (
                      <div className="w-2 h-2 rounded-full" style={{ background: 'var(--color-border-strong)' }} />
                    )}
                  </motion.div>
                  {idx < STAGES.length - 1 && (
                    <motion.div
                      className="w-0.5 flex-1 mt-1"
                      animate={{ background: done ? 'var(--color-mint)' : 'var(--color-border)' }}
                      style={{ minHeight: '32px' }}
                    />
                  )}
                </div>

                {/* Content */}
                <div className="pt-1 pb-8">
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={`${stage.id}-${done}-${active}`}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.3, delay: idx * 0.05 }}
                    >
                      <p className="font-semibold text-sm" style={{ color: upcoming ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)' }}>
                        {stage.label}
                      </p>
                      {active && stage.id === 'confirmed' && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-tertiary)' }}>
                          {blockConfirms}/12 block confirmations
                        </p>
                      )}
                      {active && stage.id === 'claimed' && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--color-mint)' }}>Recipient is claiming…</p>
                      )}
                      {stage.sublabel && !active && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-tertiary)' }}>{stage.sublabel}</p>
                      )}
                    </motion.div>
                  </AnimatePresence>
                </div>
              </div>
            )
          })}
        </div>

        {/* Claim success card */}
        <AnimatePresence>
          {currentStage === 'claimed' && (
            <motion.div
              className="mt-4 p-6 rounded-2xl text-center"
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              style={{ background: 'var(--color-mint-dim)', border: '1px solid var(--color-mint-glow)' }}
            >
              <CheckCircle2 className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--color-mint)' }} />
              <h2 className="text-xl font-bold mb-1" style={{ color: 'var(--color-text-primary)' }}>Money delivered!</h2>
              <p className="text-sm mb-4" style={{ color: 'var(--color-text-secondary)' }}>
                The recipient has claimed the funds. The transfer is complete.
              </p>
              <Link href="/dashboard"
                className="inline-flex items-center justify-center h-12 px-6 rounded-xl font-semibold text-sm w-full"
                style={{ background: 'var(--color-mint)', color: 'var(--color-ink)' }}>
                Done
              </Link>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Claim link share */}
        {currentStage !== 'claimed' && (
          <div className="mt-8 p-4 rounded-2xl" style={{ background: 'var(--color-surface)' }}>
            <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--color-text-tertiary)' }}>
              Recipient claim link
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs truncate font-mono py-2 px-3 rounded-lg"
                style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text-secondary)' }}>
                /claim/{txId.slice(0, 20)}…
              </code>
              <button onClick={handleShare}
                className="h-10 px-3 rounded-lg text-xs font-semibold press-scale shrink-0"
                style={{ background: 'var(--color-mint)', color: 'var(--color-ink)' }}>
                Share
              </button>
            </div>
            <p className="text-xs mt-2" style={{ color: 'var(--color-text-tertiary)' }}>
              <Clock className="w-3 h-3 inline mr-1" />
              Expires in 48 hours
            </p>
          </div>
        )}

        {/* Spinner for non-claimed stages */}
        {currentStage !== 'claimed' && (
          <div className="flex items-center gap-2 mt-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-text-tertiary)' }} />
            <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>Watching for updates…</span>
          </div>
        )}
      </main>
    </div>
  )
}
