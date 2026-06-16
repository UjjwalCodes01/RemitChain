/**
 * app/api/relayer/claim/route.ts
 *
 * Hardened relayer endpoint — processes OTP claims on behalf of recipients.
 *
 * SECURITY SURFACE (high-value):
 *  - Redis: 3 attempts per IP per 60 min (fast, stateless guard)
 *  - DB (otp_attempts): 3 attempts per transferId → permanent lock (durable)
 *  - Idempotency: DB status=CLAIMED → return cached txHash, no re-broadcast
 *  - Gas guard: check relayer balance before broadcasting
 *  - Phone-hash + OTP commit-reveal verified before any signing
 *  - RELAYER_PRIVATE_KEY server-side only, never logged or returned
 *  - Structured JSON logs at every step
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createPublicClient, http, toHex, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { eq } from 'drizzle-orm'
import { env } from '@/lib/env'
import { REMITCHAIN_ADDRESS, RemitChainAbi } from '@/lib/contracts'
import {
  computePhoneHash,
  computeOtpCommitHash,
  buildAndBroadcastClaim,
  type TransferData,
} from '@/lib/relayer/claim'
import { db, transfers, otpAttempts } from '@/lib/db'
import { getIpRatelimit } from '@/lib/db/redis'

// ── Active chain (selected by NEXT_PUBLIC_CHAIN_ID) ──────────────────────────
// This must match the chain the contracts are deployed on.
// Switching environments requires only env var changes — no code edits.

const CHAIN_ID = Number(env.NEXT_PUBLIC_CHAIN_ID)
const IS_MAINNET = CHAIN_ID === 1990

const activeChain = {
  id: CHAIN_ID,
  name: IS_MAINNET ? 'QIE' : 'QIE Testnet',
  nativeCurrency: { name: 'QIE', symbol: 'QIE', decimals: 18 },
  rpcUrls: { default: { http: [env.NEXT_PUBLIC_RPC_URL] } },
} as const

function getCorridorId(index: number): string {
  const mapping = ['ae-in', 'us-mx', 'gb-ng', 'sa-pk', 'sg-bd']
  return mapping[index - 1] || 'ae-in'
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3
const MIN_RELAYER_BALANCE = BigInt('10000000000000000') // 0.01 QIE in wei

// ── In-memory fallback (when DB unavailable — for local dev without Neon) ─────

interface AttemptRecord { count: number; lockUntil: number }
const attemptMap = new Map<string, AttemptRecord>()

// ── Rate-limiting helpers ─────────────────────────────────────────────────────

async function checkDbLock(transferId: string): Promise<{ locked: boolean; retryAfterMs?: number }> {
  if (!db) {
    // In-memory fallback
    const now = Date.now()
    const rec = attemptMap.get(transferId)
    if (!rec) return { locked: false }
    if (rec.lockUntil > now) return { locked: true, retryAfterMs: rec.lockUntil - now }
    return { locked: false }
  }

  const rows = await db.select().from(otpAttempts).where(eq(otpAttempts.transferId, transferId)).limit(1)
  const row = rows[0]
  if (!row || row.lockedAt === null) return { locked: false }
  return { locked: true }
}

async function recordDbFailure(transferId: string, ip: string): Promise<void> {
  if (!db) {
    const now = Date.now()
    const rec = attemptMap.get(transferId) ?? { count: 0, lockUntil: 0 }
    const newCount = rec.count + 1
    attemptMap.set(transferId, {
      count: newCount,
      lockUntil: newCount >= MAX_ATTEMPTS ? now + 10 * 60 * 1000 : rec.lockUntil,
    })
    return
  }

  const rows = await db.select().from(otpAttempts).where(eq(otpAttempts.transferId, transferId)).limit(1)
  const existing = rows[0]
  const newCount = (existing?.attemptCount ?? 0) + 1
  const now = Date.now()

  await db
    .insert(otpAttempts)
    .values({
      transferId,
      attemptCount: newCount,
      lockedAt: newCount >= MAX_ATTEMPTS ? now : null,
      lastAttemptAt: now,
      lastAttemptIp: ip,
    })
    .onConflictDoUpdate({
      target: otpAttempts.transferId,
      set: {
        attemptCount: newCount,
        lockedAt: newCount >= MAX_ATTEMPTS ? now : null,
        lastAttemptAt: now,
        lastAttemptIp: ip,
      },
    })
}

async function clearDbAttempts(transferId: string): Promise<void> {
  attemptMap.delete(transferId)
  if (!db) return
  await db.delete(otpAttempts).where(eq(otpAttempts.transferId, transferId))
}

// ── DB idempotency: check if already claimed ──────────────────────────────────

async function getDbTxHash(transferId: string): Promise<string | null> {
  if (!db) return null
  const rows = await db.select({ status: transfers.status, txHash: transfers.txHash })
    .from(transfers)
    .where(eq(transfers.id, transferId))
    .limit(1)
  const row = rows[0]
  if (row?.status === 1 && row.txHash) return row.txHash
  return null
}

// ── Structured logger ─────────────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', step: string, meta: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, step, ts: new Date().toISOString(), ...meta }))
}

// ── Razorpay Payout API Helper ───────────────────────────────────────────────

interface RazorpayPayoutResponse {
  id: string
  status: string
  utr?: string
  fees?: number
}

async function razorpayPayout(params: {
  keyId: string
  keySecret: string
  upiId: string
  amount: number       // in paise (INR)
  recipientName: string
  referenceId: string  // transferId slice for idempotency
}): Promise<RazorpayPayoutResponse> {
  const auth = Buffer.from(`${params.keyId}:${params.keySecret}`).toString('base64')
  const headers = {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/json',
    'X-Payout-Idempotency': params.referenceId, // Razorpay idempotency key
  }

  // Step 1: Create fund account
  const faRes = await fetch('https://api.razorpay.com/v1/fund_accounts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      contact_id: `contact_${params.referenceId.slice(2, 12)}`,
      account_type: 'vpa',
      vpa: { address: params.upiId },
    }),
  })

  if (!faRes.ok && faRes.status !== 400) {
    throw new Error(`Razorpay fund account error ${faRes.status}: ${await faRes.text()}`)
  }

  const fa = await faRes.json() as { id?: string }
  const fundAccountId = fa.id ?? `fa_${params.referenceId.slice(2, 12)}`

  // Step 2: Create payout
  const payoutRes = await fetch('https://api.razorpay.com/v1/payouts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      account_number: process.env.RAZORPAY_ACCOUNT_NUMBER ?? 'test_account',
      fund_account_id: fundAccountId,
      amount: params.amount,
      currency: 'INR',
      mode: 'UPI',
      purpose: 'payout',
      queue_if_low_balance: false,
      reference_id: params.referenceId,
      narration: 'RemitChain Transfer',
    }),
  })

  if (!payoutRes.ok) {
    throw new Error(`Razorpay payout error ${payoutRes.status}: ${await payoutRes.text()}`)
  }

  return payoutRes.json() as Promise<RazorpayPayoutResponse>
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try { return await fn() }
    catch (err) {
      last = err
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 600 * 2 ** i))
    }
  }
  throw last
}

// ── Input schema ──────────────────────────────────────────────────────────────

const claimSchema = z.object({
  transferId: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'transferId must be a 64-char hex bytes32 with 0x prefix'),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be exactly 6 digits'),
  recipientPhone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'recipientPhone must be E.164 format'),
  payoutId: z.string().min(1, 'Payout destination is required'),
})

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const start = Date.now()
  let transferId = 'unknown'
  let clientIp = 'unknown'

  try {
    // 1. Parse + validate body
    let body: unknown
    try { body = await req.json() }
    catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

    const parsed = claimSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      )
    }

    const { otp, recipientPhone, payoutId } = parsed.data
    transferId = parsed.data.transferId
    clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

    log('info', 'claim.start', { transferId: transferId.slice(0, 10) + '…' })

  // 2a. Redis IP rate-limit (fast check, per IP per hour)
  const ipLimiter = getIpRatelimit()
  if (ipLimiter) {
    const { success, remaining } = await ipLimiter.limit(clientIp)
    if (!success) {
      log('warn', 'claim.ip_rate_limited', { ip: clientIp })
      return NextResponse.json(
        { error: 'Too many requests from this IP. Try again later.' },
        { status: 429 },
      )
    }
    log('info', 'claim.ip_ok', { remaining })
  }

  // 2b. DB transferId lock (durable across restarts)
  const lockCheck = await checkDbLock(transferId)
  if (lockCheck.locked) {
    log('warn', 'claim.transfer_locked', { transferId: transferId.slice(0, 10) + '…' })
    return NextResponse.json(
      { error: 'Too many failed attempts for this transfer. Contact support.', retryAfterMs: lockCheck.retryAfterMs },
      { status: 429 },
    )
  }

  // 3. Validate relayer env
  if (!env.RELAYER_PRIVATE_KEY || !env.NEXT_PUBLIC_RELAYER_ADDRESS) {
    log('error', 'claim.missing_env', {})
    return NextResponse.json({ error: 'Relayer not configured' }, { status: 500 })
  }

  const relayerPrivateKey = env.RELAYER_PRIVATE_KEY as `0x${string}`
  const relayerAddress = env.NEXT_PUBLIC_RELAYER_ADDRESS as `0x${string}`

  const account = privateKeyToAccount(relayerPrivateKey)
  if (account.address.toLowerCase() !== relayerAddress.toLowerCase()) {
    log('error', 'claim.key_mismatch', {})
    return NextResponse.json({ error: 'Relayer misconfiguration' }, { status: 500 })
  }

  const publicClient = createPublicClient({
    chain: activeChain,
    transport: http(env.NEXT_PUBLIC_RPC_URL),
  })

  // 4. Gas balance guard — prevent silent failures when relayer is dry
  try {
    const balance = await publicClient.getBalance({ address: relayerAddress })
    if (balance < MIN_RELAYER_BALANCE) {
      log('error', 'claim.low_gas', { balance: formatEther(balance) })
      return NextResponse.json(
        { error: 'Relayer wallet has insufficient gas. Please contact support.' },
        { status: 503 },
      )
    }
  } catch (err) {
    log('warn', 'claim.balance_check_failed', { err: String(err).slice(0, 100) })
    // Non-fatal: proceed anyway — let the broadcast fail with a clear error
  }

  // 5. Fetch transfer from chain (authoritative source of truth)
  let transfer: TransferData
  try {
    transfer = await publicClient.readContract({
      address: REMITCHAIN_ADDRESS,
      abi: RemitChainAbi,
      functionName: 'getTransfer',
      args: [transferId as `0x${string}`],
    }) as TransferData
  } catch (err) {
    log('error', 'claim.fetch_failed', { err: String(err).slice(0, 100) })
    return NextResponse.json({ error: 'Failed to fetch transfer from chain' }, { status: 502 })
  }

  log('info', 'claim.transfer_fetched', { status: transfer.status })

  // Sync transfer to DB if it exists on-chain but is missing from DB cache (prevents foreign key errors on otp_attempts)
  if (db) {
    try {
      const existing = await db
        .select({ id: transfers.id })
        .from(transfers)
        .where(eq(transfers.id, transferId))
        .limit(1)

      if (existing.length === 0) {
        log('info', 'claim.sync_missing_transfer_to_db', { transferId })
        const corridorId = getCorridorId(transfer.corridor)
        
        // Map on-chain status (1=PENDING, 2=CLAIMED, 3=CANCELLED) to DB status (0=PENDING, 1=CLAIMED, 2=CANCELLED)
        let dbStatus = 0
        if (transfer.status === 1) dbStatus = 0
        else if (transfer.status === 2) dbStatus = 1
        else if (transfer.status === 3) dbStatus = 2

        await db.insert(transfers).values({
          id: transferId,
          txHash: null,
          senderAddress: transfer.sender.toLowerCase(),
          recipientPhoneHash: transfer.recipientPhoneHash,
          recipientNickname: null,
          amount: transfer.amount.toString(),
          corridor: corridorId,
          status: dbStatus,
          offrampStatus: 'NONE',
          smsStatus: 'PENDING',
          recipientEmail: null,
          emailStatus: 'PENDING',
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000),
          expiry: Number(transfer.expiry),
        })
      }
    } catch (dbErr) {
      log('error', 'claim.sync_missing_transfer_failed', { err: String(dbErr) })
    }
  }

  // Validate payoutId format based on corridor
  const payoutIdClean = payoutId.trim()
  if (transfer.corridor === 1 && !/^[\w.-]+@[\w.-]+$/.test(payoutIdClean)) {
    return NextResponse.json({ error: 'Invalid UPI ID format' }, { status: 400 })
  }
  if (transfer.corridor === 2 && !/^\d{18}$/.test(payoutIdClean)) {
    return NextResponse.json({ error: 'Invalid SPEI CLABE (must be 18 digits)' }, { status: 400 })
  }
  if (transfer.corridor === 3 && !/^\d{10}$/.test(payoutIdClean)) {
    return NextResponse.json({ error: 'Invalid OPay account (must be 10 digits)' }, { status: 400 })
  }
  if (transfer.corridor === 4 && !/^\d{11}$/.test(payoutIdClean)) {
    return NextResponse.json({ error: 'Invalid JazzCash number (must be 11 digits)' }, { status: 400 })
  }
  if (transfer.corridor === 5 && !/^\d{11}$/.test(payoutIdClean)) {
    return NextResponse.json({ error: 'Invalid bKash number (must be 11 digits)' }, { status: 400 })
  }

  // 6. Idempotency — already CLAIMED on-chain (status=2) → return cached txHash + offramp data
  if (transfer.status === 2) {
    const cachedTxHash = await getDbTxHash(transferId)
    let offrampStatus = 'NONE'
    let offrampMethod = null
    let offrampReference = null

    if (db) {
      const rows = await db.select({
        offrampStatus: transfers.offrampStatus,
        offrampMethod: transfers.offrampMethod,
        offrampReference: transfers.offrampReference,
      }).from(transfers).where(eq(transfers.id, transferId)).limit(1)
      if (rows[0]) {
        offrampStatus = rows[0].offrampStatus
        offrampMethod = rows[0].offrampMethod
        offrampReference = rows[0].offrampReference
      }
    }

    if (!cachedTxHash && db) {
      try {
        const corridorId = getCorridorId(transfer.corridor)
        await db.insert(transfers).values({
          id: transferId,
          txHash: null,
          senderAddress: transfer.sender.toLowerCase(),
          recipientPhoneHash: transfer.recipientPhoneHash,
          recipientNickname: null,
          amount: transfer.amount.toString(),
          corridor: corridorId,
          status: 1, // CLAIMED
          offrampStatus,
          offrampMethod,
          offrampReference,
          smsStatus: 'SENT',
          recipientEmail: null,
          emailStatus: 'PENDING',
          createdAt: Math.floor(Date.now() / 1000) - 3600,
          updatedAt: Math.floor(Date.now() / 1000),
          claimedAt: Math.floor(Date.now() / 1000),
          expiry: Number(transfer.expiry),
        })
      } catch (e) {
        log('warn', 'claim.idempotent_insert_failed', { err: String(e).slice(0, 100) })
      }
    }
    log('info', 'claim.idempotent', { transferId: transferId.slice(0, 10) + '…' })
    return NextResponse.json({ success: true, idempotent: true, txHash: cachedTxHash, offrampStatus, offrampMethod, offrampReference })
  }

  // 7. Guard: must be PENDING (status=1). NONE=0 means not found; CANCELLED=3 is terminal.
  if (transfer.status !== 1) {
    log('warn', 'claim.not_pending', { status: transfer.status })
    return NextResponse.json({ error: 'Transfer is not in a claimable state' }, { status: 400 })
  }

  // 8. Expiry check
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  if (nowSec > transfer.expiry) {
    log('warn', 'claim.expired', {})
    return NextResponse.json({ error: 'Transfer has expired' }, { status: 400 })
  }

  // 9. Phone hash verification
  const derivedPhoneHash = computePhoneHash(recipientPhone)
  if (derivedPhoneHash.toLowerCase() !== transfer.recipientPhoneHash.toLowerCase()) {
    await recordDbFailure(transferId, clientIp)
    log('warn', 'claim.phone_mismatch', {})
    return NextResponse.json({ error: 'Phone number does not match transfer' }, { status: 400 })
  }

  // 10. OTP commit-reveal check
  const otpReveal = toHex(BigInt(otp), { size: 32 })
  const derivedCommitHash = computeOtpCommitHash(
    otpReveal as `0x${string}`,
    transferId as `0x${string}`,
    relayerAddress,
  )

  if (derivedCommitHash.toLowerCase() !== transfer.otpCommitHash.toLowerCase()) {
    await recordDbFailure(transferId, clientIp)
    log('warn', 'claim.otp_mismatch', {})
    return NextResponse.json({ error: 'Invalid OTP' }, { status: 400 })
  }

  // 11. Broadcast claim
  log('info', 'claim.broadcasting', { transferId: transferId.slice(0, 10) + '…' })

  // 12a. Execute offramp logic
  let offrampStatus = 'COMPLETED'
  let offrampMethod = 'UPI'
  let offrampReference = ''

  if (transfer.corridor === 1) {
    offrampMethod = 'UPI'
    const keyId = process.env.RAZORPAY_KEY_ID
    const keySecret = process.env.RAZORPAY_KEY_SECRET
    const amountPaise = Math.round((Number(transfer.amount) / 1000000) * 83.45 * 100)

    if (!keyId || !keySecret || keyId.startsWith('rzp_test_')) {
      offrampReference = `rp_stub_${Date.now()}_${transferId.slice(2, 8)}`
      offrampStatus = 'COMPLETED'
      log('info', 'claim.offramp_upi_stub', { amountPaise, payoutIdClean })
    } else {
      try {
        const payout = await withRetry(() =>
          razorpayPayout({
            keyId,
            keySecret,
            upiId: payoutIdClean,
            amount: amountPaise,
            recipientName: 'Recipient',
            referenceId: transferId.slice(2, 18),
          })
        )
        offrampReference = payout.id
        offrampStatus = payout.status === 'failed' ? 'FAILED' : 'COMPLETED'
        log('info', 'claim.offramp_upi_razorpay_success', { payoutId: payout.id })
      } catch (payoutErr) {
        log('error', 'claim.offramp_upi_razorpay_failed', { err: String(payoutErr) })
        offrampStatus = 'FAILED'
        offrampReference = `rp_failed_${Date.now()}`
      }
    }
  } else {
    // General stub for other corridors
    const mapping: Record<number, { method: string; rate: number }> = {
      2: { method: 'SPEI', rate: 17.12 },
      3: { method: 'OPay', rate: 2018.0 },
      4: { method: 'JazzCash', rate: 75.2 },
      5: { method: 'bKash', rate: 82.4 },
    }
    const cfg = mapping[transfer.corridor] || { method: 'Payout', rate: 1.0 }
    offrampMethod = cfg.method
    offrampReference = `${cfg.method.toLowerCase()}_stub_${Date.now()}_${transferId.slice(2, 8)}`
    log('info', 'claim.offramp_stub', { corridor: transfer.corridor, method: offrampMethod, payoutIdClean })
  }

  try {
    const { txHash } = await buildAndBroadcastClaim({
      transferId: transferId as `0x${string}`,
      otpReveal: otpReveal as `0x${string}`,
      relayerPrivateKey,
      relayerAddress,
      rpcUrl: env.NEXT_PUBLIC_RPC_URL,
      chain: activeChain as Parameters<typeof buildAndBroadcastClaim>[0]['chain'],
    })

    // 12b. Persist to DB + clear attempts
    await clearDbAttempts(transferId)
    if (db) {
      const updated = await db
        .update(transfers)
        .set({
          status: 1, // CLAIMED in DB
          claimedAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000),
          txHash,
          offrampStatus,
          offrampMethod,
          offrampReference,
        })
        .where(eq(transfers.id, transferId))
        .returning()

      if (updated.length === 0) {
        try {
          const corridorId = getCorridorId(transfer.corridor)
          await db.insert(transfers).values({
            id: transferId,
            txHash,
            senderAddress: transfer.sender.toLowerCase(),
            recipientPhoneHash: transfer.recipientPhoneHash,
            recipientNickname: null,
            amount: transfer.amount.toString(),
            corridor: corridorId,
            status: 1, // CLAIMED
            offrampStatus,
            offrampMethod,
            offrampReference,
            smsStatus: 'SENT',
            recipientEmail: null,
            emailStatus: 'PENDING',
            createdAt: Math.floor(Date.now() / 1000) - 60,
            updatedAt: Math.floor(Date.now() / 1000),
            claimedAt: Math.floor(Date.now() / 1000),
            expiry: Number(transfer.expiry),
          })
        } catch (insertErr) {
          log('error', 'claim.fallback_insert_failed', { err: String(insertErr).slice(0, 100) })
        }
      }
    }

    log('info', 'claim.success', {
      transferId: transferId.slice(0, 10) + '…',
      durationMs: Date.now() - start,
    })

    return NextResponse.json({ success: true, txHash, offrampStatus, offrampMethod, offrampReference })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log('error', 'claim.broadcast_failed', { err: msg.slice(0, 200) })

    if (msg.includes('InvalidOTPReveal')) {
      await recordDbFailure(transferId, clientIp)
      return NextResponse.json({ error: 'Invalid OTP' }, { status: 400 })
    }
    if (msg.includes('TransferExpired')) {
      return NextResponse.json({ error: 'Transfer has expired' }, { status: 400 })
    }
    if (msg.includes('TransferNotPending')) {
      return NextResponse.json({ error: 'Transfer is no longer pending' }, { status: 400 })
    }

    return NextResponse.json(
      { error: 'Failed to process claim. Please try again.' },
      { status: 500 },
    )
  }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log('error', 'claim.fatal_unhandled', { err: msg })
    return NextResponse.json(
      { error: `Internal server error: ${msg.slice(0, 150)}` },
      { status: 500 },
    )
  }
}
