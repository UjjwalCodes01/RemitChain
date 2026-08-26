'use client'

/**
 * Group send — one real transfer per recipient.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS PAGE USED TO SEND NOTHING AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * The previous implementation signed an EIP-2612 permit with a RANDOM nonce
 * (`BigInt(Math.floor(Math.random() * 1000000))`) against a token that does not
 * implement permit, hashed the phone with an unsalted `keccak256(toBytes(phone))`
 * that matched nothing else in the system, and then did this:
 *
 *     // For the hackathon, we'll just simulate it succeeding and generate a
 *     // fake tx hash to show the tracker.
 *     transferIds.push(`0x${...crypto.getRandomValues(32 bytes)...}`)
 *     router.push(`/transfer/${transferIds[0]}`)
 *
 * No transaction was ever broadcast. The sender was shown a tracker for a
 * transfer ID that had never existed, and no recipient received anything.
 *
 * It now runs the same prepare → approve → send → confirm flow as the single
 * send page, once per recipient, sequentially. Sequential is not a limitation
 * to work around: each transfer consumes the sender's on-chain nonce, and the
 * server derives the transfer ID from it, so they must be ordered.
 *
 * That means two wallet confirmations per recipient. That is the real cost of
 * sending to several people, and showing it honestly is better than hiding it
 * behind a signature that does nothing.
 */

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'motion/react'
import { ArrowLeft, Plus, X, Users, Check, Loader2, AlertCircle } from 'lucide-react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { parseUnits } from 'viem'
import {
  REMITCHAIN_ADDRESS,
  ESCROW_VAULT_ADDRESS,
  QUSD_ADDRESS,
  QUSD_DECIMALS,
  RemitChainAbi,
  ERC20Abi,
} from '@/lib/contracts'
import { useChainGuard } from '@/hooks/useChainGuard'
import { activeChain } from '@/lib/chains'

interface CorridorInfo {
  id: string
  label: string
  flags: string
  rail: string
  open: boolean
  closedReason?: string
}

type RowStatus = 'idle' | 'sending' | 'sent' | 'failed'

interface Recipient {
  id: string
  phone: string
  email: string
  amount: string
  status: RowStatus
  transferId?: string
  error?: string
}

function newRecipient(): Recipient {
  return { id: crypto.randomUUID(), phone: '', email: '', amount: '', status: 'idle' }
}

export default function GroupSendPage() {
  const router = useRouter()
  const { address, isConnected } = useAccount()
  const { wrongChain } = useChainGuard()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [recipients, setRecipients] = useState<Recipient[]>([newRecipient()])
  const [corridors, setCorridors] = useState<CorridorInfo[]>([])
  const [corridorId, setCorridorId] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/corridors')
      .then(r => r.json())
      .then((data: { corridors: CorridorInfo[] }) => {
        if (cancelled) return
        setCorridors(data.corridors ?? [])
        const firstOpen = (data.corridors ?? []).find(c => c.open)
        if (firstOpen) setCorridorId(prev => prev || firstOpen.id)
      })
      .catch(() => { if (!cancelled) setCorridors([]) })
    return () => { cancelled = true }
  }, [])

  const corridor = corridors.find(c => c.id === corridorId) ?? null
  const openCorridors = corridors.filter(c => c.open)

  const addRecipient = () => setRecipients(rs => [...rs, newRecipient()])

  const removeRecipient = (id: string) =>
    setRecipients(rs => (rs.length === 1 ? rs : rs.filter(r => r.id !== id)))

  const updateRecipient = (id: string, field: 'phone' | 'email' | 'amount', value: string) =>
    setRecipients(rs => rs.map(r => (r.id === id ? { ...r, [field]: value } : r)))

  const patchRecipient = (id: string, patch: Partial<Recipient>) =>
    setRecipients(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)))

  const totalAmount = recipients.reduce((acc, r) => acc + (parseFloat(r.amount) || 0), 0)

  const canSend =
    isConnected &&
    !wrongChain &&
    Boolean(corridor?.open) &&
    !sending &&
    recipients.every(r => r.phone.trim().length > 5 && parseFloat(r.amount) >= 1)

  /** Send one recipient end to end. Throws on failure. */
  async function sendOne(recipient: Recipient): Promise<string> {
    // 1. Prepare — the server mints the OTP and claim secret and returns the
    //    exact arguments to sign.
    const prepareRes = await fetch('/api/transfers/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        senderAddress: address,
        corridorId,
        amount: parseUnits(recipient.amount, QUSD_DECIMALS).toString(),
        phone: recipient.phone.trim(),
        email: recipient.email.trim() || undefined,
      }),
    })
    const prepared = await prepareRes.json()
    if (!prepareRes.ok) throw new Error(prepared.error ?? 'Could not prepare this transfer')

    const { transferId, sendArgs } = prepared as {
      transferId: `0x${string}`
      sendArgs: {
        recipientPhoneHash: `0x${string}`
        amount: string
        otpCommitHash: `0x${string}`
        corridor: number
      }
    }
    const value = BigInt(sendArgs.amount)

    // 2. Approve the vault to pull this amount.
    const approveTx = await writeContractAsync({
      address: QUSD_ADDRESS,
      abi: ERC20Abi,
      functionName: 'approve',
      args: [ESCROW_VAULT_ADDRESS, value],
    })
    if (publicClient) await publicClient.waitForTransactionReceipt({ hash: approveTx })

    // 3. Send.
    const tx = await writeContractAsync({
      address: REMITCHAIN_ADDRESS,
      abi: RemitChainAbi,
      functionName: 'sendRemittance',
      args: [sendArgs.recipientPhoneHash, value, sendArgs.otpCommitHash, sendArgs.corridor],
    })

    // 4. Confirm — the server verifies the receipt, then notifies the recipient.
    const confirmRes = await fetch('/api/transfers/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transferId, txHash: tx }),
    })
    if (!confirmRes.ok && confirmRes.status !== 202) {
      const body = await confirmRes.json().catch(() => ({}))
      throw new Error(
        body.error ??
        'Funds are locked on-chain but the recipient could not be notified. Open the transfer to resend.',
      )
    }

    return transferId
  }

  const handleSend = async () => {
    if (!canSend || !address) return
    setSending(true)
    setError('')
    setProgress({ done: 0, total: recipients.length })

    const succeeded: string[] = []

    // Sequential, because each send consumes the sender's on-chain nonce and
    // the transfer ID is derived from it. Running these in parallel would make
    // every transfer after the first unclaimable.
    for (const [index, recipient] of recipients.entries()) {
      if (recipient.status === 'sent') {
        succeeded.push(recipient.transferId!)
        setProgress({ done: index + 1, total: recipients.length })
        continue
      }

      patchRecipient(recipient.id, { status: 'sending', error: undefined })

      try {
        const transferId = await sendOne(recipient)
        patchRecipient(recipient.id, { status: 'sent', transferId })
        succeeded.push(transferId)
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err)
        const friendly = raw.includes('User rejected') || raw.includes('user rejected')
          ? 'You cancelled this signature.'
          : raw.slice(0, 160)
        patchRecipient(recipient.id, { status: 'failed', error: friendly })

        // Stop rather than pressing on. Continuing would ask for more wallet
        // confirmations while the sender is looking at an error, and the
        // already-sent transfers stay valid regardless.
        setError(
          `Stopped at recipient ${index + 1}. ${succeeded.length} of ${recipients.length} ` +
          `sent successfully — those are on-chain and unaffected. Fix the error below and ` +
          `press send again to continue from where it stopped.`,
        )
        setSending(false)
        setProgress(null)
        return
      }

      setProgress({ done: index + 1, total: recipients.length })
    }

    setSending(false)
    setProgress(null)
    if (navigator.vibrate) navigator.vibrate([30, 50, 30])

    // Every recipient got their own transfer; the dashboard lists them all.
    if (succeeded.length === 1) router.push(`/transfer/${succeeded[0]}`)
    else router.push('/dashboard')
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ink)' }}>
      <div
        className="flex items-center gap-3 px-4 pt-14 pb-4 sticky top-0 z-10"
        style={{ background: 'rgba(10,10,11,0.92)', backdropFilter: 'blur(20px)', borderBottom: '1px solid var(--color-border)' }}
      >
        <button
          onClick={() => router.back()}
          className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: 'var(--color-surface)' }}
          aria-label="Go back"
        >
          <ArrowLeft className="w-5 h-5" style={{ color: 'var(--color-text-primary)' }} />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-bold" style={{ color: 'var(--color-text-primary)', letterSpacing: '-0.03em' }}>
            Group Send
          </h1>
          <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
            One transfer per person, sent one after another
          </p>
        </div>
      </div>

      <main className="flex-1 px-4 pt-6 pb-40">
        {/* Destination */}
        <div className="mb-6">
          <label
            htmlFor="group-corridor"
            className="block text-xs font-semibold uppercase tracking-widest mb-2"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            Destination
          </label>
          <select
            id="group-corridor"
            value={corridorId}
            onChange={e => setCorridorId(e.target.value)}
            className="w-full h-12 px-4 rounded-xl text-sm outline-none"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
          >
            {openCorridors.length === 0 && <option value="">No destinations available</option>}
            {openCorridors.map(c => (
              <option key={c.id} value={c.id}>{c.flags}  {c.label} · via {c.rail}</option>
            ))}
          </select>
          <p className="text-xs mt-2" style={{ color: 'var(--color-text-tertiary)' }}>
            Everyone in this group is paid through the same corridor.
          </p>
        </div>

        {/* Two confirmations per person — say so before they start. */}
        <div
          className="mb-6 p-3 rounded-xl flex gap-2"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-text-tertiary)' }} />
          <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
            Your wallet will ask you to confirm <strong>twice per recipient</strong> — once
            to approve the amount, once to send. {recipients.length} recipient
            {recipients.length === 1 ? '' : 's'} means {recipients.length * 2} confirmations.
          </p>
        </div>

        <AnimatePresence>
          {recipients.map((r, idx) => (
            <motion.div
              key={r.id}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-4 p-4 rounded-2xl relative"
              style={{
                background: 'var(--color-surface)',
                border: r.status === 'failed'
                  ? '1px solid var(--color-coral)'
                  : r.status === 'sent'
                    ? '1px solid var(--color-mint)'
                    : '1px solid transparent',
              }}
            >
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-semibold uppercase tracking-widest flex items-center gap-2" style={{ color: 'var(--color-text-tertiary)' }}>
                  Recipient {idx + 1}
                  {r.status === 'sending' && <Loader2 className="w-3 h-3 animate-spin" style={{ color: 'var(--color-mint)' }} />}
                  {r.status === 'sent' && <Check className="w-3 h-3" style={{ color: 'var(--color-mint)' }} />}
                </span>
                {recipients.length > 1 && r.status !== 'sent' && (
                  <button
                    onClick={() => removeRecipient(r.id)}
                    className="p-1 -mr-2 rounded-lg"
                    style={{ color: 'var(--color-text-tertiary)' }}
                    aria-label={`Remove recipient ${idx + 1}`}
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className="space-y-3">
                <input
                  type="tel"
                  placeholder="Phone number (+91…)"
                  value={r.phone}
                  disabled={r.status === 'sent' || sending}
                  onChange={e => updateRecipient(r.id, 'phone', e.target.value)}
                  className="w-full h-12 px-4 rounded-xl text-sm outline-none font-mono disabled:opacity-60"
                  style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
                />
                <input
                  type="email"
                  placeholder="Email for their claim code"
                  value={r.email}
                  disabled={r.status === 'sent' || sending}
                  onChange={e => updateRecipient(r.id, 'email', e.target.value)}
                  className="w-full h-12 px-4 rounded-xl text-sm outline-none disabled:opacity-60"
                  style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
                />
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder="Amount (min 1 QUSD)"
                  value={r.amount}
                  disabled={r.status === 'sent' || sending}
                  onChange={e => updateRecipient(r.id, 'amount', e.target.value)}
                  className="w-full h-12 px-4 rounded-xl text-sm outline-none font-mono disabled:opacity-60"
                  style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
                />
              </div>

              {r.status === 'sent' && r.transferId && (
                <p className="text-xs mt-3" style={{ color: 'var(--color-mint)' }}>
                  Sent · <a href={`/transfer/${r.transferId}`} className="underline">track it</a>
                </p>
              )}
              {r.status === 'failed' && r.error && (
                <p className="text-xs mt-3" style={{ color: 'var(--color-coral)' }}>{r.error}</p>
              )}
            </motion.div>
          ))}
        </AnimatePresence>

        <button
          onClick={addRecipient}
          disabled={sending}
          className="w-full h-14 rounded-2xl flex items-center justify-center gap-2 font-semibold text-sm press-scale border-2 border-dashed disabled:opacity-50"
          style={{ borderColor: 'var(--color-border-strong)', color: 'var(--color-text-secondary)' }}
        >
          <Plus className="w-4 h-4" /> Add another recipient
        </button>
      </main>

      {/* Sticky footer */}
      <div
        className="fixed bottom-0 left-0 right-0 p-4 pt-6"
        style={{ background: 'linear-gradient(to top, rgba(10,10,11,1) 70%, rgba(10,10,11,0))' }}
      >
        {error && (
          <p className="text-sm text-center mb-4" role="alert" style={{ color: 'var(--color-coral)' }}>
            {error}
          </p>
        )}

        {wrongChain && (
          <p className="text-sm text-center mb-4" style={{ color: 'var(--color-coral)' }}>
            Switch your wallet to {activeChain.name} first.
          </p>
        )}

        <div className="flex items-center justify-between px-2 mb-4">
          <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>Total to send</span>
          <span className="font-mono font-bold text-lg" style={{ color: 'var(--color-text-primary)' }}>
            {totalAmount.toFixed(2)} <span className="text-sm">QUSD</span>
          </span>
        </div>

        <button
          onClick={handleSend}
          disabled={!canSend}
          className="w-full h-14 rounded-2xl font-semibold flex items-center justify-center gap-2 press-scale pb-[env(safe-area-inset-bottom,0px)]"
          style={{ background: 'var(--color-mint)', color: 'var(--color-ink)', opacity: canSend ? 1 : 0.5 }}
        >
          {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Users className="w-5 h-5" />}
          {sending && progress
            ? `Sending ${progress.done + 1} of ${progress.total}…`
            : `Send to ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'}`}
        </button>
      </div>
    </div>
  )
}
