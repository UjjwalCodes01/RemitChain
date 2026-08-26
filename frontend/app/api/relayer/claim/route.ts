/**
 * POST /api/relayer/claim
 *
 * The recipient redeems their transfer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ORDER OF OPERATIONS — the important part
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. verify credentials (phone commitment + OTP commitment, both on-chain)
 *   2. validate the payout destination
 *   3. BROADCAST the on-chain claim and wait for it to be mined
 *   4. record the settlement
 *   5. THEN create the payout ledger row and hand it to the worker
 *
 * The previous implementation ran the Razorpay payout at step 2½ — before the
 * broadcast. A revert, an RPC timeout or a serverless timeout between the two
 * meant real rupees had left the treasury against an escrow that never
 * released, with no ledger entry to reconcile from. Money now only ever moves
 * outward after the chain has confirmed it moved inward.
 *
 * Steps 3 and 5 are not atomic — nothing spanning a blockchain and a payment
 * provider can be. The failure mode is deliberately one-sided: a crash between
 * them leaves a claimed transfer with no payout, which
 * `findOrphanedClaims()` detects and the payout cron repairs. The reverse —
 * a payout with no claim — is unrecoverable, so it is made impossible.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createPublicClient, http, formatEther, type Hex } from 'viem'
import { eq } from 'drizzle-orm'
import { env, IS_PRODUCTION_CHAIN } from '@/lib/env'
import { relayerAddress, relayerPrivateKey } from '@/lib/env.server'
import { serverChain } from '@/lib/chain-config'
import { REMITCHAIN_ADDRESS, RemitChainAbi, FEE_BPS } from '@/lib/contracts'
import {
  buildAndBroadcastClaim,
  mapClaimRevert,
  ChainStatus,
  type TransferData,
} from '@/lib/relayer/claim'
import {
  CLAIM_SECRET_PATTERN,
  OTP_PATTERN,
  deriveOtpReveal,
  deriveOtpCommitHash,
  legacyOtpReveal,
  isLegacySchemeAllowed,
} from '@/lib/claim-secret'
import { parsePhone, phoneHashMatches } from '@/lib/phone'
import { getCorridorByIndex, validateDestination } from '@/lib/corridors'
import { db, transfers } from '@/lib/db'
import { enqueuePayout, getPayoutForTransfer, submitPayout, toPublicPayout } from '@/lib/payouts/ledger'
import { checkOtpLock, recordOtpFailure, clearOtpAttempts } from '@/lib/otp-guard'
import { rateLimit } from '@/lib/ratelimit'
import { clientIp, log, shortId } from '@/lib/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Relayer must hold at least this much gas before we attempt a claim. */
const MIN_RELAYER_BALANCE_WEI = 10_000_000_000_000_000n // 0.01 QIE

const claimSchema = z.object({
  transferId: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid transfer reference'),
  otp: z.string().regex(OTP_PATTERN, 'The code must be 6 digits'),
  recipientPhone: z.string().min(4).max(32),
  payoutDestination: z.string().min(1).max(120),
  /** From the claim link fragment. Absent only for legacy in-flight transfers. */
  claimSecret: z.string().regex(CLAIM_SECRET_PATTERN).optional(),
})

export async function POST(req: NextRequest) {
  const started = Date.now()
  const ip = clientIp(req)

  // ── Parse ──────────────────────────────────────────────────────────────────
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const parsed = claimSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Please check the details and try again.', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const { transferId, otp, recipientPhone, payoutDestination, claimSecret } = parsed.data

  // ── Rate limits ────────────────────────────────────────────────────────────
  const ipLimit = await rateLimit('claim:ip', ip, { limit: 10, windowSeconds: 3600 })
  if (!ipLimit.success) {
    log('warn', 'claim.ip_rate_limited', { ip })
    return NextResponse.json(
      { error: 'Too many attempts from this network. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfterSeconds) } },
    )
  }

  const lock = await checkOtpLock(transferId)
  if (lock.locked) {
    log('warn', 'claim.transfer_locked', { transferId: shortId(transferId) })
    return NextResponse.json(
      {
        error: `Too many incorrect codes. Please try again in ${Math.ceil(lock.retryAfterMs / 60_000)} minutes.`,
        retryAfterMs: lock.retryAfterMs,
      },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(lock.retryAfterMs / 1000)) } },
    )
  }

  const publicClient = createPublicClient({ chain: serverChain, transport: http(env.NEXT_PUBLIC_RPC_URL) })

  // ── Read the authoritative transfer state ─────────────────────────────────
  let transfer: TransferData
  try {
    transfer = (await publicClient.readContract({
      address: REMITCHAIN_ADDRESS,
      abi: RemitChainAbi,
      functionName: 'getTransfer',
      args: [transferId as Hex],
    })) as TransferData
  } catch (err) {
    log('error', 'claim.chain_read_failed', { err: String(err).slice(0, 200) })
    return NextResponse.json(
      { error: 'We could not reach the network. Please try again.' },
      { status: 502 },
    )
  }

  if (transfer.status === ChainStatus.NONE) {
    return NextResponse.json({ error: 'We could not find this transfer.' }, { status: 404 })
  }

  const corridor = getCorridorByIndex(transfer.corridor)
  if (!corridor) {
    log('error', 'claim.unknown_corridor', { corridor: transfer.corridor })
    return NextResponse.json(
      { error: 'This transfer uses a destination we no longer support. Please contact support.' },
      { status: 409 },
    )
  }

  // ── Already claimed: report the payout, never re-broadcast ────────────────
  if (transfer.status === ChainStatus.CLAIMED) {
    const payout = await getPayoutForTransfer(transferId)
    log('info', 'claim.idempotent', { transferId: shortId(transferId) })
    return NextResponse.json({
      success: true,
      idempotent: true,
      payout: payout ? toPublicPayout(payout) : null,
      // A claimed transfer with no payout row is the orphan case; the cron
      // repairs it, so tell the recipient it is in progress rather than lost.
      payoutStatus: payout?.status ?? 'CREATED',
    })
  }

  if (transfer.status === ChainStatus.CANCELLED) {
    return NextResponse.json(
      { error: 'This transfer was cancelled and refunded to the sender.' },
      { status: 409 },
    )
  }

  // ── Expiry ────────────────────────────────────────────────────────────────
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  if (nowSeconds >= transfer.expiry) {
    return NextResponse.json(
      { error: 'This transfer has expired. The sender can reclaim the funds.' },
      { status: 410 },
    )
  }

  // ── Credential checks ─────────────────────────────────────────────────────
  // Both are verified against values stored ON-CHAIN, never against anything
  // this request supplied or anything cached in the database.

  const phone = parsePhone(recipientPhone, corridor.recvCountry)
  if (!phone.ok) {
    await recordOtpFailure(transferId, ip)
    return NextResponse.json({ error: 'Please enter a valid phone number.' }, { status: 400 })
  }

  if (!phoneHashMatches(phone.e164, transfer.recipientPhoneHash)) {
    await recordOtpFailure(transferId, ip)
    log('warn', 'claim.phone_mismatch', { transferId: shortId(transferId) })
    // Deliberately the same message as a bad OTP: distinguishing them tells an
    // attacker which half of the credentials they have already guessed.
    return NextResponse.json(
      { error: 'Those details do not match this transfer. Please check and try again.' },
      { status: 400 },
    )
  }

  const otpReveal = resolveOtpReveal({
    transferId: transferId as Hex,
    otp,
    claimSecret,
    recipient: relayerAddress(),
    onChainCommit: transfer.otpCommitHash,
  })

  if (!otpReveal) {
    const attempt = await recordOtpFailure(transferId, ip)
    log('warn', 'claim.otp_mismatch', { transferId: shortId(transferId), attempts: attempt.attemptCount })
    return NextResponse.json(
      {
        error: 'Those details do not match this transfer. Please check and try again.',
        attemptsRemaining: attempt.attemptsRemaining,
      },
      { status: 400 },
    )
  }

  // ── Payout destination ────────────────────────────────────────────────────
  const destination = validateDestination(corridor, payoutDestination)
  if (!destination.ok) {
    // Not a credential failure — do not spend one of the recipient's attempts.
    return NextResponse.json({ error: destination.error }, { status: 400 })
  }

  // ── Relayer gas ───────────────────────────────────────────────────────────
  try {
    const balance = await publicClient.getBalance({ address: relayerAddress() })
    if (balance < MIN_RELAYER_BALANCE_WEI) {
      log('error', 'claim.relayer_out_of_gas', { balance: formatEther(balance) })
      return NextResponse.json(
        { error: 'We are temporarily unable to process claims. Please try again shortly.' },
        { status: 503 },
      )
    }
  } catch (err) {
    log('warn', 'claim.balance_check_failed', { err: String(err).slice(0, 120) })
    // Non-fatal: the broadcast below will fail loudly if gas really is short.
  }

  // ── Settle on-chain ───────────────────────────────────────────────────────
  let claimTxHash: Hex
  try {
    log('info', 'claim.broadcasting', { transferId: shortId(transferId) })
    const result = await buildAndBroadcastClaim({
      transferId: transferId as Hex,
      otpReveal,
      relayerPrivateKey: relayerPrivateKey(),
      relayerAddress: relayerAddress(),
      rpcUrl: env.NEXT_PUBLIC_RPC_URL,
      chain: serverChain as unknown as Parameters<typeof buildAndBroadcastClaim>[0]['chain'],
    })
    claimTxHash = result.txHash
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('error', 'claim.broadcast_failed', { transferId: shortId(transferId), err: message.slice(0, 300) })

    const mapped = mapClaimRevert(message)
    if (mapped) {
      if (mapped.status === 400) await recordOtpFailure(transferId, ip)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    return NextResponse.json(
      { error: 'We could not complete your claim. No money has moved — please try again.' },
      { status: 502 },
    )
  }

  // From here the escrow HAS released. Nothing below may fail the request in a
  // way that suggests otherwise.
  await clearOtpAttempts(transferId)

  const netAmount = transfer.amount - (transfer.amount * BigInt(FEE_BPS)) / 10_000n
  const settledAt = Date.now()

  const stored = await recordSettlement({
    transferId,
    claimTxHash,
    transfer,
    netAmount,
    corridorId: corridor.id,
    settledAt,
  })

  // ── Hand off to the payout ledger ─────────────────────────────────────────
  const enqueued = await enqueuePayout(
    {
      transferId,
      corridorId: corridor.id,
      destination: destination.value,
      netAmountBaseUnits: netAmount,
      quotedRate: stored?.quotedRate ?? null,
      quotedLocalMinor: stored?.quotedLocalMinor ?? null,
    },
    IS_PRODUCTION_CHAIN,
  )

  if (!enqueued.ok) {
    // The escrow released but we could not queue the payout. This is the
    // orphan case the cron repairs; never report failure to the recipient,
    // because their money is genuinely on its way.
    log('error', 'claim.enqueue_failed', {
      transferId: shortId(transferId),
      code: enqueued.code,
      error: enqueued.error,
    })
    return NextResponse.json({
      success: true,
      txHash: claimTxHash,
      payoutStatus: 'CREATED',
      payout: null,
      message: 'Your transfer is confirmed and the payout is being arranged.',
    })
  }

  // Try to submit immediately so the recipient sees real progress rather than
  // waiting for the next cron tick. The cron remains the guarantee — this is
  // only a latency optimisation, and a failure here is picked up on retry.
  if (enqueued.created) {
    try {
      await submitPayout(enqueued.payout.id)
    } catch (err) {
      log('warn', 'claim.inline_submit_failed', {
        payoutId: enqueued.payout.id,
        err: String(err).slice(0, 200),
      })
    }
  }

  const finalPayout = await getPayoutForTransfer(transferId)

  log('info', 'claim.success', {
    transferId: shortId(transferId),
    payoutStatus: finalPayout?.status,
    durationMs: Date.now() - started,
  })

  return NextResponse.json({
    success: true,
    txHash: claimTxHash,
    payout: finalPayout ? toPublicPayout(finalPayout) : null,
    payoutStatus: finalPayout?.status ?? 'CREATED',
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ResolveOtpInput {
  transferId: Hex
  otp: string
  claimSecret?: string
  recipient: Hex
  onChainCommit: string
}

/**
 * Work out which `otpReveal` reproduces the on-chain commitment.
 *
 * Tries the current high-entropy derivation first. Falls back to the legacy
 * "OTP zero-padded to 32 bytes" scheme only while ALLOW_LEGACY_OTP_SCHEME is
 * set, so transfers created before the upgrade can still be claimed during the
 * 48-hour cutover window.
 *
 * Returns null when neither matches.
 */
function resolveOtpReveal(input: ResolveOtpInput): Hex | null {
  const target = input.onChainCommit.toLowerCase()

  if (input.claimSecret) {
    try {
      const reveal = deriveOtpReveal(input.claimSecret, input.otp)
      if (deriveOtpCommitHash(reveal, input.transferId, input.recipient).toLowerCase() === target) {
        return reveal
      }
    } catch {
      // Malformed secret — fall through to the legacy attempt.
    }
  }

  if (isLegacySchemeAllowed()) {
    const reveal = legacyOtpReveal(input.otp)
    if (deriveOtpCommitHash(reveal, input.transferId, input.recipient).toLowerCase() === target) {
      return reveal
    }
  }

  return null
}

interface SettlementInput {
  transferId: string
  claimTxHash: Hex
  transfer: TransferData
  netAmount: bigint
  corridorId: string
  settledAt: number
}

/**
 * Mark the transfer settled and destroy the claim credentials.
 *
 * Returns the locked quote if the transfer carried one, so the payout is priced
 * at the rate the sender was shown.
 */
async function recordSettlement(
  input: SettlementInput,
): Promise<{ quotedRate: string | null; quotedLocalMinor: string | null } | null> {
  if (!db) return null

  try {
    const rows = await db.select().from(transfers).where(eq(transfers.id, input.transferId)).limit(1)
    const existing = rows[0]

    const patch = {
      status: 1, // CLAIMED
      claimTxHash: input.claimTxHash,
      claimedAt: input.settledAt,
      updatedAt: input.settledAt,
      // The credentials have served their purpose. Wiping them means a later
      // database compromise cannot be used to claim anything.
      claimSecretEnc: null,
      otpEnc: null,
    }

    if (existing) {
      await db.update(transfers).set(patch).where(eq(transfers.id, input.transferId))
      return {
        quotedRate: existing.quotedRate,
        quotedLocalMinor: existing.quotedLocalMinor,
      }
    }

    // No local row: a transfer sent before this deployment, or one whose
    // prepare row was lost. Reconstruct from chain so the payout has something
    // to reference.
    await db.insert(transfers).values({
      id: input.transferId,
      claimTxHash: input.claimTxHash,
      senderAddress: input.transfer.sender.toLowerCase(),
      recipientPhoneHash: input.transfer.recipientPhoneHash,
      amount: input.transfer.amount.toString(),
      netAmount: input.netAmount.toString(),
      feeAmount: (input.transfer.amount - input.netAmount).toString(),
      corridor: input.corridorId,
      status: 1,
      notifyStatus: 'SENT',
      createdAt: input.settledAt,
      updatedAt: input.settledAt,
      claimedAt: input.settledAt,
      expiry: Number(input.transfer.expiry) * 1000,
    })
    return null
  } catch (err) {
    // The chain is the source of truth; a bookkeeping failure must not be
    // reported to a recipient whose money has already been released.
    log('error', 'claim.settlement_record_failed', {
      transferId: shortId(input.transferId),
      err: String(err).slice(0, 300),
    })
    return null
  }
}
