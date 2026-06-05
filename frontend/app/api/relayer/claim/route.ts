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

// ── Input schema ──────────────────────────────────────────────────────────────

const claimSchema = z.object({
  transferId: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'transferId must be a 64-char hex bytes32 with 0x prefix'),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be exactly 6 digits'),
  recipientPhone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'recipientPhone must be E.164 format'),
})

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const start = Date.now()

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

  const { transferId, otp, recipientPhone } = parsed.data
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

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

  // 6. Idempotency — already CLAIMED on-chain → return cached txHash from DB
  if (transfer.status === 1) {
    const cachedTxHash = await getDbTxHash(transferId)
    log('info', 'claim.idempotent', { transferId: transferId.slice(0, 10) + '…' })
    return NextResponse.json({ success: true, idempotent: true, txHash: cachedTxHash })
  }

  // 7. Guard: must be PENDING (0)
  if (transfer.status !== 0) {
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

  try {
    const { txHash } = await buildAndBroadcastClaim({
      transferId: transferId as `0x${string}`,
      otpReveal: otpReveal as `0x${string}`,
      relayerPrivateKey,
      relayerAddress,
      rpcUrl: env.NEXT_PUBLIC_RPC_URL,
      chain: activeChain as Parameters<typeof buildAndBroadcastClaim>[0]['chain'],
    })

    // 12. Persist to DB + clear attempts
    await clearDbAttempts(transferId)
    if (db) {
      await db
        .update(transfers)
        .set({ status: 1, claimedAt: Date.now(), updatedAt: Date.now(), txHash })
        .where(eq(transfers.id, transferId))
    }

    log('info', 'claim.success', {
      transferId: transferId.slice(0, 10) + '…',
      durationMs: Date.now() - start,
    })

    return NextResponse.json({ success: true, txHash })

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
}
