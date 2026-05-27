'use client'

import { useParams } from 'next/navigation'
import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { CheckCircle2, Loader2, AlertCircle } from 'lucide-react'
import { useReadContract } from 'wagmi'
import { REMITCHAIN_ADDRESS, RemitChainAbi } from '@/lib/contracts'
import { NavBar } from '@/components/NavBar'
import Link from 'next/link'

export default function ClaimPage() {
  const params = useParams()
  const txId = typeof params.txId === 'string' ? params.txId : Array.isArray(params.txId) ? params.txId[0] : ''
  const transferId = txId.startsWith('0x') ? (txId as `0x${string}`) : `0x${txId}` as `0x${string}`

  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [claimState, setClaimState] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  // 1. Fetch Transfer Status
  const { data: transfer, isLoading } = useReadContract({
    address: REMITCHAIN_ADDRESS,
    abi: RemitChainAbi,
    functionName: 'getTransfer',
    args: [transferId],
    query: {
      enabled: Boolean(transferId && transferId.length === 66),
      refetchInterval: claimState === 'success' ? false : 3000, // Poll until claimed
    }
  })

  // Transfer.status enum: 0 = PENDING, 1 = CLAIMED, 2 = CANCELLED
  const status = transfer?.status

  // Handle OTP Input
  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  const handleChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return
    
    // Handle paste of full 6 digits
    if (value.length === 6) {
      const newOtp = value.split('')
      setOtp(newOtp)
      inputRefs.current[5]?.focus()
      return
    }

    const newOtp = [...otp]
    newOtp[index] = value.substring(value.length - 1)
    setOtp(newOtp)

    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus()
    }
  }

  const isOtpComplete = otp.every(d => d !== '')

  const submitClaim = async () => {
    if (!isOtpComplete) return
    setClaimState('submitting')
    setErrorMsg('')

    try {
      const res = await fetch('/api/relayer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transferId,
          otp: otp.join('')
        })
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Failed to claim transfer')
      }

      setClaimState('success')
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate([30, 50, 30])
    } catch (err: unknown) {
      console.error(err)
      setClaimState('error')
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error')
      setOtp(['', '', '', '', '', ''])
      inputRefs.current[0]?.focus()
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(200)
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ink)' }}>
      <NavBar hideConnect />
      
      <main className="flex-1 flex flex-col items-center justify-center px-4 pt-24 pb-16">
        <motion.div 
          className="w-full max-w-sm mx-auto text-center"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          {isLoading ? (
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--color-mint)' }} />
              <p style={{ color: 'var(--color-text-secondary)' }}>Loading transfer details...</p>
            </div>
          ) : !transfer ? (
            <div className="p-6 rounded-2xl border" style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
              <AlertCircle className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--color-coral)' }} />
              <h1 className="text-xl font-bold mb-2">Transfer Not Found</h1>
              <p style={{ color: 'var(--color-text-secondary)' }}>The link may be broken or the transfer ID is invalid.</p>
            </div>
          ) : status === 1 || claimState === 'success' ? (
            <motion.div 
              className="p-8 rounded-2xl border" 
              style={{ background: 'var(--color-surface)', borderColor: 'var(--color-mint-glow)' }}
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
            >
              <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6"
                   style={{ background: 'var(--color-mint-dim)', color: 'var(--color-mint)' }}>
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h1 className="text-2xl font-bold mb-2">Claim Successful</h1>
              <p className="text-sm mb-6" style={{ color: 'var(--color-text-secondary)' }}>
                The funds have been released and are on their way to your local account via the selected off-ramp rail.
              </p>
              <Link
                href="/"
                className="inline-flex h-12 px-6 items-center justify-center rounded-xl font-semibold transition-colors w-full"
                style={{ background: 'var(--color-mint)', color: 'var(--color-ink)' }}
              >
                Done
              </Link>
            </motion.div>
          ) : status === 2 ? (
            <div className="p-6 rounded-2xl border" style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
              <AlertCircle className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--color-coral)' }} />
              <h1 className="text-xl font-bold mb-2">Transfer Cancelled</h1>
              <p style={{ color: 'var(--color-text-secondary)' }}>This transfer has been cancelled by the sender or expired.</p>
            </div>
          ) : (
            <>
              <div className="mb-10">
                <h1 className="text-3xl font-bold mb-3 tracking-tight">Claim Funds</h1>
                <p style={{ color: 'var(--color-text-secondary)' }}>
                  Enter the 6-digit OTP provided by the sender to release the funds.
                </p>
              </div>

              <div className="flex justify-between gap-2 mb-8">
                {otp.map((digit, i) => (
                  <input
                    key={i}
                    ref={el => { inputRefs.current[i] = el }}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\d*"
                    maxLength={6}
                    value={digit}
                    onChange={e => handleChange(i, e.target.value)}
                    onKeyDown={e => handleKeyDown(i, e)}
                    disabled={claimState === 'submitting'}
                    className="w-12 h-16 rounded-xl text-center text-2xl font-bold border outline-none transition-all"
                    style={{ 
                      background: 'var(--color-surface)',
                      borderColor: digit ? 'var(--color-mint)' : 'var(--color-border)',
                      color: 'var(--color-text-primary)',
                      fontFamily: 'var(--font-mono)'
                    }}
                  />
                ))}
              </div>

              <AnimatePresence mode="wait">
                {claimState === 'error' && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="mb-6 p-3 rounded-lg flex items-start gap-3 text-left"
                    style={{ background: 'rgba(255, 107, 107, 0.1)', color: 'var(--color-coral)' }}
                  >
                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                    <span className="text-sm">{errorMsg}</span>
                  </motion.div>
                )}
              </AnimatePresence>

              <button
                disabled={!isOtpComplete || claimState === 'submitting'}
                onClick={submitClaim}
                className="w-full h-14 rounded-xl font-semibold flex items-center justify-center transition-all"
                style={{
                  background: isOtpComplete ? 'var(--color-mint)' : 'var(--color-surface-elevated)',
                  color: isOtpComplete ? 'var(--color-ink)' : 'var(--color-text-tertiary)',
                  opacity: claimState === 'submitting' ? 0.8 : 1
                }}
              >
                {claimState === 'submitting' ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin mr-2" />
                    Verifying...
                  </>
                ) : (
                  'Claim Funds'
                )}
              </button>
            </>
          )}
        </motion.div>
      </main>
    </div>
  )
}
