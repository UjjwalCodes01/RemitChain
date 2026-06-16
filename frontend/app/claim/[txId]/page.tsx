'use client'

import { useParams, useSearchParams } from 'next/navigation'
import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { CheckCircle2, Loader2, AlertCircle, Phone, FlaskConical, ChevronDown, Banknote } from 'lucide-react'
import { useReadContract } from 'wagmi'
import { REMITCHAIN_ADDRESS, RemitChainAbi } from '@/lib/contracts'
import { NavBar } from '@/components/NavBar'
import Link from 'next/link'

export default function ClaimPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const txId = typeof params.txId === 'string' ? params.txId : Array.isArray(params.txId) ? params.txId[0] : ''
  const transferId = txId.startsWith('0x') ? (txId as `0x${string}`) : `0x${txId}` as `0x${string}`

  const IS_DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === 'true'
  const otpFromUrl = searchParams.get('otp')
  const judgeToken = searchParams.get('judge')
  const [isJudgeVerified, setIsJudgeVerified] = useState(false)
  const [demoRevealed, setDemoRevealed] = useState(false)

  // Verify judge token on mount/params change if not in public demo mode
  useEffect(() => {
    if (IS_DEMO || !judgeToken || !transferId || transferId.length !== 66) return
    fetch(`/api/transfers/${transferId}/demo-otp?judge=${encodeURIComponent(judgeToken)}`)
      .then(res => {
        if (res.ok) setIsJudgeVerified(true)
      })
      .catch(() => {})
  }, [transferId, judgeToken, IS_DEMO])

  const showDemoCard = IS_DEMO || isJudgeVerified

  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [payoutId, setPayoutId] = useState('')
  const [claimedPayoutId, setClaimedPayoutId] = useState('')
  const [claimedRailName, setClaimedRailName] = useState('')
  const [claimState, setClaimState] = useState<'idle' | 'submitting' | 'success' | 'idempotent' | 'error' | 'locked'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [retryAfterMs, setRetryAfterMs] = useState(0)
  const [countdown, setCountdown] = useState(0)
  const [smsResendState, setSmsResendState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [smsResendCooldown, setSmsResendCooldown] = useState(0)
  const [currentTime, setCurrentTime] = useState<number>(0)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    setCurrentTime(Math.floor(Date.now() / 1000))
  }, [])

  // Countdown timer for lockout
  useEffect(() => {
    if (claimState !== 'locked' || retryAfterMs <= 0) return
    const lockUntil = Date.now() + retryAfterMs
    const interval = setInterval(() => {
      const remaining = Math.max(0, lockUntil - Date.now())
      setCountdown(Math.ceil(remaining / 1000))
      if (remaining === 0) { setClaimState('idle'); clearInterval(interval) }
    }, 500)
    const timer = setTimeout(() => setCountdown(Math.ceil(retryAfterMs / 1000)), 0)
    return () => {
      clearInterval(interval)
      clearTimeout(timer)
    }
  }, [claimState, retryAfterMs])

  // SMS resend cooldown
  useEffect(() => {
    if (smsResendState !== 'sent') return
    const until = Date.now() + 60_000
    const id = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000))
      setSmsResendCooldown(remaining)
      if (remaining === 0) { setSmsResendState('idle'); clearInterval(id) }
    }, 500)
    const timer = setTimeout(() => setSmsResendCooldown(60), 0)
    return () => {
      clearInterval(id)
      clearTimeout(timer)
    }
  }, [smsResendState])

  // 1. Fetch Transfer Status
  const { data: transfer, isLoading } = useReadContract({
    address: REMITCHAIN_ADDRESS,
    abi: RemitChainAbi,
    functionName: 'getTransfer',
    args: [transferId],
    query: {
      enabled: Boolean(transferId && transferId.length === 66),
      refetchInterval: claimState === 'success' ? false : 3000,
    }
  })

  const status = transfer ? Number(transfer.status) : undefined

  // Corridor rail calculations
  const corridorId = transfer ? Number(transfer.corridor) : 1
  let railName = 'UPI'
  let railPlaceholder = 'recipient@upi'
  let railLabel = 'UPI ID / VPA'
  let railDescription = 'Funds will be deposited directly to this UPI address.'
  let payoutRegexp = /^[\w.-]+@[\w.-]+$/

  if (corridorId === 1) {
    railName = 'UPI'
    railPlaceholder = 'recipient@upi'
    railLabel = 'UPI ID / VPA'
    railDescription = 'Funds will be deposited directly to this UPI address.'
    payoutRegexp = /^[\w.-]+@[\w.-]+$/
  } else if (corridorId === 2) {
    railName = 'SPEI'
    railPlaceholder = '18-digit CLABE number'
    railLabel = 'SPEI CLABE'
    railDescription = '18-digit Mexican bank CLABE account number.'
    payoutRegexp = /^\d{18}$/
  } else if (corridorId === 3) {
    railName = 'OPay'
    railPlaceholder = '10-digit OPay account number'
    railLabel = 'OPay Account'
    railDescription = '10-digit Nigerian mobile wallet number.'
    payoutRegexp = /^\d{10}$/
  } else if (corridorId === 4) {
    railName = 'JazzCash'
    railPlaceholder = '11-digit JazzCash account number'
    railLabel = 'JazzCash Account'
    railDescription = '11-digit Pakistani mobile money account number.'
    payoutRegexp = /^\d{11}$/
  } else if (corridorId === 5) {
    railName = 'bKash'
    railPlaceholder = '11-digit bKash account number'
    railLabel = 'bKash Account'
    railDescription = '11-digit Bangladesh bKash wallet number.'
    payoutRegexp = /^\d{11}$/
  }

  // Handle OTP Input
  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  const handleChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return

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
  // E.164-ish validation: must start with + and have at least 7 digits
  const isPhoneValid = /^\+[1-9]\d{6,14}$/.test(phone.trim())
  const isPayoutIdValid = payoutRegexp.test(payoutId.trim())
  const canSubmit = isOtpComplete && isPhoneValid && isPayoutIdValid && claimState === 'idle'

  const submitClaim = async () => {
    if (!canSubmit) return
    setClaimState('submitting')
    setErrorMsg('')

    try {
      const res = await fetch('/api/relayer/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transferId,
          otp: otp.join(''),
          recipientPhone: phone.trim(),
          payoutId: payoutId.trim(),
        })
      })

      const data = await res.json()

      if (res.status === 429) {
        setRetryAfterMs(data.retryAfterMs ?? 600_000)
        setClaimState('locked')
        if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(200)
        return
      }

      if (!res.ok) {
        // Map relayer errors to user-friendly messages
        let friendly = data.error || 'Failed to claim transfer'
        if (friendly.includes('Phone number does not match')) {
          friendly = "That phone number doesn't match this transfer. Use the same number the sender used."
        } else if (friendly.includes('Invalid OTP')) {
          friendly = 'Incorrect code. Double-check the 6 digits and try again.'
        } else if (friendly.includes('expired')) {
          friendly = 'This transfer has expired. The sender has been refunded.'
        } else if (friendly.includes('not in a claimable state')) {
          friendly = 'This transfer has already been claimed or cancelled.'
        }
        throw new Error(friendly)
      }

      // idempotent = already claimed on-chain before this session
      if (data.idempotent) {
        if (data.offrampMethod) {
          setClaimedRailName(data.offrampMethod)
        }
        setClaimState('idempotent')
      } else {
        setClaimedPayoutId(payoutId.trim())
        setClaimedRailName(railName)
        setClaimState('success')
      }
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
          ) : claimState === 'success' ? (
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
              <h1 className="text-2xl font-bold mb-2">Claim Successful! 🎉</h1>
              <p className="text-sm mb-6" style={{ color: 'var(--color-text-secondary)' }}>
                The funds have been released and are on their way to your local <strong style={{ color: 'var(--color-mint)' }}>{claimedRailName || railName}</strong> account{claimedPayoutId ? ` (${claimedPayoutId})` : ''}.
              </p>
              <Link
                href="/"
                className="inline-flex h-12 px-6 items-center justify-center rounded-xl font-semibold transition-colors w-full"
                style={{ background: 'var(--color-mint)', color: 'var(--color-ink)' }}
              >
                Done
              </Link>
            </motion.div>
          ) : claimState === 'idempotent' || status === 2 ? (
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
              <h1 className="text-2xl font-bold mb-2">Already Claimed</h1>
              <p className="text-sm mb-6" style={{ color: 'var(--color-text-secondary)' }}>
                This transfer has already been claimed. The funds were released successfully to your local <strong style={{ color: 'var(--color-mint)' }}>{claimedRailName || railName}</strong> account.
              </p>
              <Link
                href="/"
                className="inline-flex h-12 px-6 items-center justify-center rounded-xl font-semibold transition-colors w-full"
                style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text-primary)' }}
              >
                Back to RemitChain
              </Link>
            </motion.div>
          ) : status === 3 || (transfer && Number(transfer.expiry) > 0 && currentTime > Number(transfer.expiry)) ? (
            <motion.div
              className="p-8 rounded-2xl border text-center"
              style={{ background: 'var(--color-surface)', borderColor: 'rgba(255,107,92,0.25)' }}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
            >
              <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-5"
                style={{ background: 'var(--color-coral-dim)' }}>
                <AlertCircle className="w-8 h-8" style={{ color: 'var(--color-coral)' }} />
              </div>
              <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--color-text-primary)' }}>
                {status === 2 ? 'Transfer Cancelled' : 'Transfer Expired'}
              </h1>
              <p className="text-sm mb-6" style={{ color: 'var(--color-text-secondary)' }}>
                {status === 2
                  ? 'This transfer was cancelled by the sender.'
                  : 'This transfer expired 48 hours after it was created. The sender has been automatically refunded.'}
              </p>
              <Link href="/" className="inline-flex h-12 px-6 items-center justify-center rounded-xl font-semibold w-full"
                style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text-primary)' }}>
                Back to RemitChain
              </Link>
            </motion.div>
          ) : claimState === 'locked' ? (
            <motion.div
              className="p-8 rounded-2xl border text-center"
              style={{ background: 'var(--color-surface)', borderColor: 'rgba(255,107,107,0.3)' }}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
            >
              <AlertCircle className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--color-coral)' }} />
              <h1 className="text-xl font-bold mb-2">Too Many Attempts</h1>
              <p className="text-sm mb-4" style={{ color: 'var(--color-text-secondary)' }}>
                This transfer has been locked after 3 failed attempts.
              </p>
              <div className="text-4xl font-mono font-bold mb-2" style={{ color: 'var(--color-mint)' }}>
                {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
              </div>
              <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>Try again after the timer expires</p>
            </motion.div>
          ) : (
            <>
              <div className="mb-8">
                <h1 className="text-3xl font-bold mb-3 tracking-tight">Claim Funds</h1>
                <p style={{ color: 'var(--color-text-secondary)' }}>
                  Enter your phone number and the 6-digit code from the sender.
                </p>
              </div>

                {/* Demo Mode — OTP Reveal (only shown when ?otp= param present and showDemoCard is true) */}
                {showDemoCard && otpFromUrl && (
                  <motion.div
                    className="mb-6 rounded-xl border overflow-hidden text-left"
                    style={{ borderColor: 'rgba(245,166,35,0.4)', background: 'rgba(245,166,35,0.06)' }}
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                  >
                    <button
                      onClick={() => {
                        setDemoRevealed(r => !r)
                        if (!demoRevealed) {
                          // Auto-fill the OTP inputs
                          const digits = otpFromUrl.split('')
                          if (digits.length === 6) setOtp(digits)
                        }
                      }}
                      className="w-full flex items-center gap-2 px-4 py-3"
                    >
                      <FlaskConical className="w-4 h-4 shrink-0" style={{ color: '#F5A623' }} />
                      <span className="text-sm font-semibold" style={{ color: '#F5A623' }}>Demo Mode — Reveal claim code</span>
                      <ChevronDown
                        className="w-4 h-4 ml-auto transition-transform"
                        style={{ color: '#F5A623', transform: demoRevealed ? 'rotate(180deg)' : 'rotate(0deg)' }}
                      />
                    </button>
                    <AnimatePresence>
                      {demoRevealed && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="px-4 pb-4 border-t" style={{ borderColor: 'rgba(245,166,35,0.2)' }}>
                            <p className="text-xs mt-3 mb-1" style={{ color: 'rgba(245,166,35,0.7)' }}>Claim code (auto-filled above):</p>
                            <div className="text-3xl font-black font-mono tracking-[0.2em]" style={{ color: 'var(--color-text-primary)' }}>
                              {otpFromUrl}
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                )}

              {/* Phone input */}
              <div className="mb-6 text-left">
                <label className="block text-xs font-semibold uppercase tracking-widest mb-2"
                  style={{ color: 'var(--color-text-tertiary)' }}>
                  Your Phone Number
                </label>
                <div className="flex items-center gap-3 px-4 h-14 rounded-xl border"
                  style={{
                    background: 'var(--color-surface)',
                    borderColor: isPhoneValid ? 'var(--color-mint)' : 'var(--color-border)'
                  }}>
                  <Phone className="w-4 h-4 shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
                  <input
                    type="tel"
                    inputMode="tel"
                    placeholder="+919876543210"
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    className="flex-1 bg-transparent outline-none text-sm"
                    style={{ color: 'var(--color-text-primary)' }}
                    aria-label="Your phone number in international format"
                  />
                </div>
                <p className="text-xs mt-1.5" style={{ color: 'var(--color-text-tertiary)' }}>
                  Must match the number the sender used (E.164 format, e.g. +919876543210)
                </p>
              </div>

              {/* Payout Destination Input */}
              <div className="mb-6 text-left">
                <label className="block text-xs font-semibold uppercase tracking-widest mb-2"
                  style={{ color: 'var(--color-text-tertiary)' }}>
                  Payout Destination ({railLabel})
                </label>
                <div className="flex items-center gap-3 px-4 h-14 rounded-xl border"
                  style={{
                    background: 'var(--color-surface)',
                    borderColor: payoutId ? (isPayoutIdValid ? 'var(--color-mint)' : 'rgba(255,107,107,0.5)') : 'var(--color-border)'
                  }}>
                  <Banknote className="w-4 h-4 shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
                  <input
                    type="text"
                    placeholder={railPlaceholder}
                    value={payoutId}
                    onChange={e => setPayoutId(e.target.value)}
                    className="flex-1 bg-transparent outline-none text-sm font-mono"
                    style={{ color: 'var(--color-text-primary)' }}
                    aria-label={railLabel}
                  />
                </div>
                <p className="text-xs mt-1.5" style={{ color: 'var(--color-text-tertiary)' }}>
                  {railDescription}
                </p>
              </div>

              {/* OTP input */}
              <div className="mb-8">
                <label className="block text-xs font-semibold uppercase tracking-widest mb-2 text-left"
                  style={{ color: 'var(--color-text-tertiary)' }}>
                  6-Digit Code
                </label>
                <div className="flex justify-between gap-2">
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
                      aria-label={`OTP digit ${i + 1}`}
                    />
                  ))}
                </div>
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
                id="claim-submit-btn"
                disabled={!canSubmit}
                onClick={submitClaim}
                className="w-full h-14 rounded-xl font-semibold flex items-center justify-center transition-all"
                style={{
                  background: canSubmit ? 'var(--color-mint)' : 'var(--color-surface-elevated)',
                  color: canSubmit ? 'var(--color-ink)' : 'var(--color-text-tertiary)',
                  opacity: claimState === 'submitting' ? 0.8 : 1
                }}
              >
                {claimState === 'submitting' ? (
                  <><Loader2 className="w-5 h-5 animate-spin mr-2" />Verifying...</>
                ) : 'Claim Funds'}
              </button>

              {/* SMS resend */}
              <div className="mt-8 pt-6 border-t text-left" style={{ borderColor: 'var(--color-border)' }}>
                <p className="text-xs font-semibold mb-2" style={{ color: 'var(--color-text-tertiary)' }}>
                  Didn&apos;t receive the SMS?
                </p>
                <button
                  disabled={smsResendState !== 'idle'}
                  onClick={async () => {
                    setSmsResendState('sending')
                    try {
                      await fetch('/api/notify', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ transferId, recipientPhone: phone.trim() || undefined }),
                      })
                    } catch { /* non-fatal */ }
                    setSmsResendState('sent')
                  }}
                  className="text-xs font-semibold flex items-center gap-1.5"
                  style={{ color: smsResendState === 'idle' ? 'var(--color-mint)' : 'var(--color-text-tertiary)' }}
                >
                  {smsResendState === 'sending' && <Loader2 className="w-3 h-3 animate-spin" />}
                  {smsResendState === 'sent'
                    ? `Resent! Check your messages (retry in ${smsResendCooldown}s)`
                    : 'Resend claim link via SMS'}
                </button>
              </div>
            </>
          )}
        </motion.div>
      </main>
    </div>
  )
}
