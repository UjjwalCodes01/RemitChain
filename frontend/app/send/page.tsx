'use client'

import { motion, useSpring, useMotionValueEvent, AnimatePresence } from 'motion/react'
import { useState, useEffect, useCallback } from 'react'
import { useAccount, useChainId, usePublicClient, useWriteContract } from 'wagmi'
import { ArrowRight, ChevronDown, CheckCircle2, Loader2, Phone, UserCircle2, AlertCircle, X } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { encodeAbiParameters, encodePacked, keccak256, parseUnits, toHex } from 'viem'
import { NavBar } from '@/components/NavBar'
import { useChainGuard } from '@/hooks/useChainGuard'
import { env } from '@/lib/env'
import { REMITCHAIN_ADDRESS, ESCROW_VAULT_ADDRESS, QUSD_ADDRESS, QUSD_DECIMALS, RemitChainAbi, ERC20Abi } from '@/lib/contracts'
import { VoiceInput } from '@/components/VoiceInput'
import { verifyBiometric, isBiometricRegistered } from '@/lib/biometric/webauthn'
import { getContact } from '@/lib/contacts/db'
import type { Contact } from '@/lib/contacts/types'

// Seeded FX rates — TODO(qie): replace with QIE Oracle live rate
const CORRIDORS = [
  { id: 'ae-in', label: '🇦🇪 UAE → 🇮🇳 India', symbol: '₹', rate: 83.45, rail: 'UPI', code: 'INR' },
  { id: 'us-mx', label: '🇺🇸 USA → 🇲🇽 Mexico', symbol: 'MX$', rate: 17.12, rail: 'SPEI', code: 'MXN' },
  { id: 'gb-ng', label: '🇬🇧 UK → 🇳🇬 Nigeria', symbol: '₦', rate: 2018, rail: 'OPay', code: 'NGN' },
  { id: 'sa-pk', label: '🇸🇦 Saudi → 🇵🇰 Pakistan', symbol: '₨', rate: 75.2, rail: 'JazzCash', code: 'PKR' },
  { id: 'sg-bd', label: '🇸🇬 Singapore → 🇧🇩 Bangladesh', symbol: '৳', rate: 82.4, rail: 'bKash', code: 'BDT' },
] as const

type CorridorId = (typeof CORRIDORS)[number]['id']

const FEE_BPS = 10 // 0.1%

export default function SendPage() {
  const { isConnected, address } = useAccount()
  const chainId = useChainId()
  const { wrongChain } = useChainGuard()

  const router = useRouter()
  const searchParams = useSearchParams()
  const [rawInput, setRawInput] = useState('100')
  const [phone, setPhone] = useState(searchParams.get('phone') || '')
  const [contact, setContact] = useState<Contact | null>(null)

  useEffect(() => {
    const cid = searchParams.get('contactId')
    if (cid) getContact(cid).then(c => c && setContact(c))
  }, [searchParams])
  const [corridorId, setCorridorId] = useState<CorridorId>('ae-in')
  const [showCorridorPicker, setShowCorridorPicker] = useState(false)
  const [sendState, setSendState] = useState<'idle' | 'signing' | 'broadcasting' | 'success'>('idle')
  const [sendError, setSendError] = useState<string | null>(null)
  const [otpCode, setOtpCode] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  const corridor = CORRIDORS.find(c => c.id === corridorId) ?? CORRIDORS[0]
  const numericAmount = Math.max(0, parseFloat(rawInput) || 0)
  const fee = numericAmount * (FEE_BPS / 10000)
  const net = numericAmount - fee
  const recipientAmount = net * corridor.rate

  // Spring-animated display strings
  const springRecipient = useSpring(recipientAmount, { stiffness: 80, damping: 18, mass: 0.6 })
  const springFee = useSpring(fee, { stiffness: 80, damping: 18 })

  const [displayRecipient, setDisplayRecipient] = useState(
    recipientAmount > 0 ? recipientAmount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '0.00'
  )

  // Drive spring targets when derived values change
  useEffect(() => {
    springRecipient.set(recipientAmount)
    springFee.set(fee)
  }, [recipientAmount, fee, springRecipient, springFee])

  useMotionValueEvent(springRecipient, 'change', v => {
    setDisplayRecipient(v > 0 ? v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '0.00')
  })

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    // Allow digits and one decimal
    if (/^\d*\.?\d{0,2}$/.test(val)) {
      setRawInput(val)
    }
  }, [])

  // ─── Web3 Hooks ────────────────────────────────────────────────────────────

  // NOTE: We intentionally do NOT use useReadContracts for the nonce here.
  // The QIE testnet RPC does not reliably support multicall (eth_call batching),
  // which causes wagmi to throw "Failed to read on-chain nonces" errors on load.
  // Instead, we fetch the nonce via a plain publicClient.readContract at send time.

  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  // ─── Send Flow ─────────────────────────────────────────────────────────────

  const handleSend = async () => {
    if (!address || numericAmount < 1 || !phone) return
    setSendError(null)
    setSendState('signing')

    // Fetch senderNonce via a plain eth_call — avoids wagmi multicall issues on QIE RPC
    let freshSenderNonce: bigint
    try {
      if (!publicClient) throw new Error('No RPC client')
      freshSenderNonce = await publicClient.readContract({
        address: REMITCHAIN_ADDRESS,
        abi: RemitChainAbi,
        functionName: 'senderNonces',
        args: [address],
      }) as bigint
    } catch (e) {
      console.error('[send] Failed to read senderNonce:', e)
      setSendState('idle')
      setSendError('Could not connect to QIE network. Check your connection and that your wallet is on QIE Testnet (chain 1983).')
      return
    }

    try {
      // Biometric is optional — only prompt if a credential is already registered.
      // The real security gate is the wallet signature below.
      const credRegistered = await isBiometricRegistered().catch(() => false)
      if (credRegistered) {
        const bioOk = await verifyBiometric()
        if (!bioOk) { setSendState('idle'); return }
      }

      const remitNonce = freshSenderNonce

      // 1. Generate 6-digit OTP
      const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString()
      const otpReveal = toHex(BigInt(generatedOtp), { size: 32 })

      // 2. Compute Transfer ID deterministically
      const encodedId = encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }],
        [address, remitNonce, BigInt(chainId), REMITCHAIN_ADDRESS]
      )
      const transferId = keccak256(encodedId)

      // 3. Compute OTP Commit Hash
      const relayerAddress = env.NEXT_PUBLIC_RELAYER_ADDRESS as `0x${string}`
      const encodedCommit = encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }],
        [otpReveal, transferId, relayerAddress]
      )
      const otpCommitHash = keccak256(encodedCommit)

      // 4. Compute Phone Hash
      const SALT = toHex(BigInt('0xDEADBEEF'), { size: 32 })
      const phoneHash = keccak256(encodePacked(['bytes32', 'string'], [SALT, phone]))

      const value = parseUnits(numericAmount.toString(), QUSD_DECIMALS)
      const corridorIndex = CORRIDORS.findIndex(c => c.id === corridorId) + 1

      // 5. Step 1 — approve QUSD spend to EscrowVault
      setSendState('signing') // reuse 'signing' label for approve step
      const approveTxHash = await writeContractAsync({
        address: QUSD_ADDRESS,
        abi: ERC20Abi,
        functionName: 'approve',
        args: [ESCROW_VAULT_ADDRESS, value],
      })

      // CRITICAL: wait for the approve tx to be mined before calling sendRemittance.
      // writeContractAsync resolves on submission, not confirmation. If we call
      // sendRemittance immediately the vault sees allowance = 0 and safeTransferFrom reverts.
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: approveTxHash })
      }

      setSendState('broadcasting')

      // 6. Step 2 — sendRemittance
      const tx = await writeContractAsync({
        address: REMITCHAIN_ADDRESS,
        abi: RemitChainAbi,
        functionName: 'sendRemittance',
        args: [
          phoneHash,
          value,
          otpCommitHash,
          corridorIndex,
        ],
      })

      setTxHash(tx)
      setOtpCode(generatedOtp)
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(50)

      // Normalize phone to E.164 for API validation
      // Map corridor to country dial code for prefix
      const CORRIDOR_DIAL_CODE: Record<string, string> = {
        'ae-in': '+91', 'us-mx': '+52', 'gb-ng': '+234', 'sa-pk': '+92', 'sg-bd': '+880',
      }
      const dialCode = CORRIDOR_DIAL_CODE[corridorId] ?? '+91'
      const digits = phone.replace(/\D/g, '')
      const cleanPhone = phone.replace(/[\s-]/g, '')
      // If already has full international digits (>10), just prefix +; otherwise use corridor code
      const e164Phone = cleanPhone.startsWith('+') ? cleanPhone
        : digits.length > 10 ? `+${digits}`
        : `${dialCode}${digits.replace(/^0+/, '')}`

      // 1. Persist off-chain metadata to DB — fire-and-forget
      fetch('/api/transfers/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transferId,
          txHash: tx,
          senderAddress: address,
          recipientNickname: contact?.name ?? null,
          amount: value.toString(),
          corridor: corridorId,
        }),
      }).catch(err => console.warn('[metadata] Failed (non-fatal):', err))

      // 2. Notify recipient via SMS — fire-and-forget
      fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transferId,
          recipientPhone: e164Phone,
          amount: numericAmount,
          corridor: corridorId,
        }),
      }).then(async r => {
        if (!r.ok) console.warn('[notify] SMS 400:', await r.json().catch(() => r.text()))
      }).catch(err => console.warn('[notify] Failed (non-fatal):', err))

      router.push(`/transfer/${transferId}`)

    } catch (err: unknown) {
      console.error(err)
      setSendState('idle')
      const viemErr = err as { shortMessage?: string; message?: string }
      const raw = viemErr.shortMessage ?? viemErr.message ?? 'Unknown error'
      // Map on-chain revert reasons to user-friendly copy
      let friendly = raw
      if (raw.includes('User rejected') || raw.includes('user rejected') || raw.includes('ACTION_REJECTED')) {
        friendly = 'You cancelled the signature. Tap \'Send\' to try again.'
      } else if (raw.includes('InsufficientBalance') || raw.includes('transfer amount exceeds balance')) {
        friendly = 'Your QUSD balance is too low for this transfer.'
      } else if (raw.includes('DailyLimitExceeded')) {
        friendly = 'Daily KYC transfer limit reached. Try a smaller amount.'
      } else if (raw.includes('network') || raw.includes('fetch') || raw.includes('timeout')) {
        friendly = 'Network error. Check your connection and try again.'
      } else if (raw.length > 120) {
        friendly = raw.slice(0, 120) + '…'
      }
      setSendError(friendly)
    }
  }

  const canSend = isConnected && !wrongChain && numericAmount >= 1 && phone.length >= 8 && sendState === 'idle'

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ink)' }}>
      <NavBar />

      {/* Ambient glow */}
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        <div style={{
          position: 'absolute',
          top: '20%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: '60vw',
          height: '50vh',
          background: 'radial-gradient(ellipse, rgba(61,220,151,0.07) 0%, transparent 70%)',
          filter: 'blur(60px)',
        }} />
      </div>

      <main
        id="send-main"
        className="relative flex-1 flex flex-col items-center justify-center px-4 pt-24 pb-16"
        aria-labelledby="send-heading"
      >
        <motion.div
          className="w-full max-w-md"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
        >
          {/* Corridor picker */}
          <div className="mb-8 relative">
            <button
              id="corridor-picker"
              onClick={() => setShowCorridorPicker(v => !v)}
              className="
                flex items-center justify-between w-full rounded-xl px-4 py-3 border
                text-sm font-medium transition-colors
              "
              style={{
                background: 'var(--color-surface)',
                borderColor: showCorridorPicker ? 'var(--color-mint)' : 'var(--color-border-strong)',
                color: 'var(--color-text-primary)',
              }}
              aria-label="Select remittance corridor"
              aria-expanded={showCorridorPicker}
              aria-haspopup="listbox"
            >
              <span>{corridor.label}</span>
              <ChevronDown
                className="w-4 h-4 transition-transform"
                style={{
                  color: 'var(--color-text-tertiary)',
                  transform: showCorridorPicker ? 'rotate(180deg)' : 'none',
                }}
                aria-hidden
              />
            </button>

            <AnimatePresence>
              {showCorridorPicker && (
                <motion.div
                  role="listbox"
                  aria-label="Choose corridor"
                  className="absolute top-full left-0 right-0 mt-1 rounded-xl border overflow-hidden z-50"
                  style={{
                    background: 'var(--color-surface-elevated)',
                    borderColor: 'var(--color-border-strong)',
                    boxShadow: 'var(--shadow-lg)',
                  }}
                  initial={{ opacity: 0, y: -8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.98 }}
                  transition={{ duration: 0.15, ease: [0.32, 0.72, 0, 1] }}
                >
                  {CORRIDORS.map(c => (
                    <button
                      key={c.id}
                      role="option"
                      aria-selected={c.id === corridorId}
                      onClick={() => {
                        setCorridorId(c.id)
                        setShowCorridorPicker(false)
                      }}
                      className="w-full flex items-center justify-between px-4 py-3 text-sm transition-colors text-left"
                      style={{
                        background: c.id === corridorId ? 'var(--color-mint-dim)' : 'transparent',
                        color: c.id === corridorId ? 'var(--color-mint)' : 'var(--color-text-secondary)',
                      }}
                      onMouseEnter={e => {
                        if (c.id !== corridorId) {
                          (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-surface)'
                        }
                      }}
                      onMouseLeave={e => {
                        if (c.id !== corridorId) {
                          (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                        }
                      }}
                    >
                      <span>{c.label}</span>
                      <span className="text-xs opacity-60">via {c.rail}</span>
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Success state is now handled by tracker redirect */}

          {/* Recipient Phone Input */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--color-text-tertiary)' }}>Recipient</span>
              <Link href="/contacts" className="text-xs font-semibold press-scale" style={{ color: 'var(--color-mint)' }}>
                Choose from contacts
              </Link>
            </div>
            {contact ? (
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl border" style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
                <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm overflow-hidden shrink-0" style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-mint)' }}>
                  {contact.avatarDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={contact.avatarDataUrl} alt={contact.name} className="w-full h-full object-cover" />
                  ) : (
                    <UserCircle2 className="w-6 h-6" style={{ color: 'var(--color-text-tertiary)' }} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate" style={{ color: 'var(--color-text-primary)' }}>{contact.name}</p>
                  <p className="text-xs font-mono truncate" style={{ color: 'var(--color-text-tertiary)' }}>{contact.phoneE164}</p>
                </div>
                <button onClick={() => { setContact(null); setPhone('') }} className="text-xs font-semibold p-2" style={{ color: 'var(--color-coral)' }}>Clear</button>
              </div>
            ) : (
              <div
                className="flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors"
                style={{
                  background: 'var(--color-surface)',
                  borderColor: 'var(--color-border)',
                }}
              >
                <Phone className="w-5 h-5" style={{ color: 'var(--color-text-tertiary)' }} />
              <input
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="Recipient Phone (+91...)"
                className="bg-transparent border-none outline-none w-full text-sm font-medium"
                style={{ color: 'var(--color-text-primary)' }}
                disabled={sendState !== 'idle'}
              />
            </div>
            )}
          </div>

          {/* ════ THE LIQUID NUMBER ════ */}
          <div
            className="rounded-2xl p-8 border mb-4"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-border-strong)',
            }}
          >
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs uppercase tracking-widest font-semibold"
                style={{ color: 'var(--color-text-tertiary)' }}>
                You send (QUSD)
              </p>
              <VoiceInput onAmount={amt => setRawInput(String(amt))} />
            </div>

            {/* Giant animated input */}
            <div className="flex items-start gap-2 mb-6">
              <span
                className="text-3xl font-bold pt-3 tabular-nums"
                style={{
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text-secondary)',
                  lineHeight: 1,
                }}
              >
                $
              </span>
              <div className="relative flex-1">
                <input
                  id="send-amount"
                  type="text"
                  inputMode="decimal"
                  value={rawInput}
                  onChange={handleInput}
                  placeholder="0"
                  className="
                    w-full bg-transparent border-none outline-none tabular-nums
                    font-bold leading-none
                  "
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'clamp(3rem, 14vw, 6rem)',
                    letterSpacing: '-0.04em',
                    color: numericAmount > 0 ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                  }}
                  aria-label="Amount to send in QUSD"
                  aria-describedby="send-amount-hint"
                />
                <span id="send-amount-hint" className="sr-only">
                  Enter the amount in QUSD (US dollars). Minimum 1 QUSD.
                </span>
              </div>
            </div>

            {/* Quick amounts */}
            <div className="flex items-center gap-2 mb-6 flex-wrap">
              {[10, 50, 100, 500].map(amt => (
                <button
                  key={amt}
                  onClick={() => setRawInput(String(amt))}
                  className="px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors"
                  style={{
                    borderColor: numericAmount === amt ? 'var(--color-mint)' : 'var(--color-border)',
                    background: numericAmount === amt ? 'var(--color-mint-dim)' : 'transparent',
                    color: numericAmount === amt ? 'var(--color-mint)' : 'var(--color-text-tertiary)',
                  }}
                  aria-label={`Set amount to $${amt}`}
                >
                  ${amt}
                </button>
              ))}
            </div>

            {/* Recipient gets — spring animated */}
            <div
              className="rounded-xl p-4 border"
              style={{
                background: numericAmount > 0 ? 'var(--color-mint-dim)' : 'var(--color-surface-elevated)',
                borderColor: numericAmount > 0 ? 'var(--color-mint-glow)' : 'var(--color-border)',
                transition: 'background 0.3s, border-color 0.3s',
              }}
            >
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs" style={{ color: numericAmount > 0 ? 'var(--color-mint)' : 'var(--color-text-tertiary)' }}>
                  Recipient gets
                </p>
                <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                  via {corridor.rail}
                </p>
              </div>
              <div className="flex items-baseline gap-1">
                <span
                  className="text-xl font-bold"
                  style={{ color: numericAmount > 0 ? 'var(--color-mint)' : 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}
                  aria-hidden
                >
                  {corridor.symbol}
                </span>
                <motion.span
                  key={displayRecipient}
                  className="text-3xl font-bold tabular-nums"
                  style={{
                    color: numericAmount > 0 ? 'var(--color-mint)' : 'var(--color-text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                    letterSpacing: '-0.03em',
                  }}
                  initial={{ opacity: 0.7, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.12 }}
                  aria-live="polite"
                  aria-label={`Recipient receives ${corridor.symbol}${recipientAmount.toFixed(2)} ${corridor.code}`}
                >
                  {displayRecipient}
                </motion.span>
              </div>
              <p className="text-xs mt-1.5" style={{ color: 'var(--color-text-tertiary)' }}>
                Rate: 1 QUSD = {corridor.symbol}{corridor.rate.toLocaleString()} · Fee: 0.1% (${fee.toFixed(2)})
              </p>
            </div>
          </div>

          {/* Fee bar — visual comparison */}
          {numericAmount > 0 && (
            <motion.div
              className="rounded-xl p-4 mb-4 border"
              style={{
                background: 'var(--color-surface)',
                borderColor: 'var(--color-border)',
              }}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              transition={{ duration: 0.25 }}
              aria-label="Fee comparison"
            >
              <p className="text-xs font-semibold mb-3" style={{ color: 'var(--color-text-tertiary)' }}>
                Fee comparison
              </p>
              <FeeBar label="Western Union" feePct={4.5} amount={numericAmount} color="var(--color-coral)" />
              <FeeBar label="RemitChain" feePct={0.1} amount={numericAmount} color="var(--color-mint)" />
            </motion.div>
          )}

          {/* CTA */}
          {!isConnected ? (
            <Link
              href="/connect"
              id="send-connect-cta"
              className="press-scale flex items-center justify-center gap-2 w-full h-14 rounded-xl font-semibold text-base transition-all"
              style={{
                background: 'var(--color-mint)',
                color: 'var(--color-ink)',
                boxShadow: '0 0 40px rgba(61,220,151,0.3)',
                textDecoration: 'none',
              }}
              aria-label="Connect wallet to continue"
            >
              Connect wallet to send
              <ArrowRight className="w-5 h-5" aria-hidden />
            </Link>
          ) : (
            <button
              id="send-submit"
              disabled={!canSend}
              className="press-scale flex items-center justify-center gap-2 w-full h-14 rounded-xl font-semibold text-base transition-all"
              style={{
                background: canSend ? 'var(--color-mint)' : 'var(--color-surface-elevated)',
                color: canSend ? 'var(--color-ink)' : 'var(--color-text-tertiary)',
                boxShadow: canSend ? '0 0 40px rgba(61,220,151,0.3)' : 'none',
                border: canSend ? 'none' : '1px solid var(--color-border)',
                cursor: canSend ? 'pointer' : 'not-allowed',
              }}
              aria-label={
                !canSend
                  ? numericAmount < 1
                    ? 'Minimum 1 QUSD required'
                    : wrongChain
                      ? 'Switch to QIE Testnet first'
                      : !phone
                        ? 'Enter recipient phone'
                        : 'Enter amount'
                  : `Send $${numericAmount} QUSD`
              }
              aria-disabled={!canSend || sendState !== 'idle'}
              onClick={handleSend}
            >
              {sendState === 'signing' ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
                  Approving QUSD...
                </>
              ) : sendState === 'broadcasting' ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
                  Sending...
                </>
              ) : numericAmount < 1 ? (
                'Minimum 1 QUSD'
              ) : !phone ? (
                'Enter Phone Number'
              ) : (
                <>
                  Send ${numericAmount} →
                  {canSend && <ArrowRight className="w-5 h-5" aria-hidden />}
                </>
              )}
            </button>
          )}

          {numericAmount > 0 && numericAmount < 1 && (
            <p className="text-center text-xs mt-3" style={{ color: 'var(--color-coral)' }}>
              Minimum transfer is 1 QUSD
            </p>
          )}

          {/* ── Inline error card ── */}
          <AnimatePresence>
            {sendError && (
              <motion.div
                role="alert"
                initial={{ opacity: 0, y: -8, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.97 }}
                transition={{ duration: 0.2 }}
                className="mt-3 rounded-xl p-4 flex items-start gap-3 border"
                style={{ background: 'var(--color-coral-dim)', borderColor: 'rgba(255,107,92,0.3)' }}
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-coral)' }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium" style={{ color: 'var(--color-coral)' }}>{sendError}</p>
                  {sendError.includes('balance') && (
                    <Link href="/faucet" className="text-xs font-semibold mt-1 inline-block underline"
                      style={{ color: 'var(--color-coral)' }}>
                      Get 100 test QUSD →
                    </Link>
                  )}
                </div>
                <button onClick={() => setSendError(null)} className="shrink-0 p-0.5" aria-label="Dismiss error">
                  <X className="w-3.5 h-3.5" style={{ color: 'var(--color-coral)' }} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </main>
    </div>
  )
}

/* ── Fee comparison bar ─────────────────────────────────────── */
interface FeeBarProps {
  label: string
  feePct: number
  amount: number
  color: string
}

function FeeBar({ label, feePct, amount, color }: FeeBarProps) {
  const feeAmount = (amount * feePct) / 100
  const widthPct = Math.min((feePct / 6) * 100, 100)

  return (
    <div className="mb-2">
      <div className="flex items-center justify-between text-xs mb-1">
        <span style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
        <span style={{ color }} className="font-mono tabular-nums">
          {feePct}% · ${feeAmount.toFixed(2)}
        </span>
      </div>
      <div
        className="h-1.5 rounded-full overflow-hidden"
        style={{ background: 'var(--color-surface-elevated)' }}
        role="progressbar"
        aria-valuenow={feePct}
        aria-valuemin={0}
        aria-valuemax={6}
        aria-label={`${label} fee: ${feePct}%`}
      >
        <motion.div
          className="h-full rounded-full"
          style={{ background: color }}
          initial={{ width: 0 }}
          animate={{ width: `${widthPct}%` }}
          transition={{ duration: 0.6, ease: [0.32, 0.72, 0, 1] }}
        />
      </div>
    </div>
  )
}
