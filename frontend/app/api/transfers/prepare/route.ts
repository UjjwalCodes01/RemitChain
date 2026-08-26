/**
 * POST /api/transfers/prepare
 *
 * Step 1 of sending. Mints the claim credentials and returns the exact
 * arguments the sender's wallet should pass to `sendRemittance`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE BROWSER NO LONGER DOES THIS
 * ─────────────────────────────────────────────────────────────────────────────
 * The send page used to generate the OTP with `Math.random()`, derive the
 * phone hash with a salt hard-coded in the client bundle, build the commitment
 * itself, and then POST the plaintext OTP to /api/notify afterwards. That
 * meant:
 *
 *   - the OTP came from a non-cryptographic PRNG whose output is predictable
 *     from a handful of observed values;
 *   - the phone salt was public, so `recipientPhoneHash` on-chain was
 *     reversible;
 *   - /api/notify accepted any (transferId, otp, email) triple from anyone, so
 *     an attacker could send a chosen OTP for someone else's transfer to an
 *     address they controlled.
 *
 * Everything security-relevant now happens here, on the server, and the OTP
 * never touches the browser at all.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createPublicClient, http, isAddress, type Hex } from 'viem'
import { isNull } from 'drizzle-orm'
import { env, IS_PRODUCTION_CHAIN, appUrl } from '@/lib/env'
import { serverEnv, relayerAddress } from '@/lib/env.server'
import { serverChain } from '@/lib/chain-config'
import { REMITCHAIN_ADDRESS, RemitChainAbi, FEE_BPS, QUSD_DECIMALS } from '@/lib/contracts'
import { getCorridorById, isCorridorOpen } from '@/lib/corridors'
import { computeTransferId } from '@/lib/transfer-id'
import { generateClaimCredentials, deriveCommitment } from '@/lib/claim-secret'
import { computePhoneHash, maskPhone, parsePhone } from '@/lib/phone'
import { encryptSecret } from '@/lib/crypto/secretbox'
import { quotePayout } from '@/lib/fx/rates'
import { db, transfers } from '@/lib/db'
import { getRedis } from '@/lib/db/redis'
import { rateLimit } from '@/lib/ratelimit'
import { clientIp, log } from '@/lib/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Matches the on-chain MIN_AMOUNT of 1 QUSD. */
const MIN_AMOUNT_BASE_UNITS = 1_000_000n
/** Ceiling per transfer. Belt and braces alongside the on-chain KYC limit. */
const MAX_AMOUNT_BASE_UNITS = 10_000_000_000n // 10,000 QUSD

const prepareSchema = z.object({
  senderAddress: z.string().refine(isAddress, 'Invalid sender address'),
  corridorId: z.string().min(1),
  /** QUSD base units (6 decimals) as a decimal string. */
  amount: z.string().regex(/^\d{1,20}$/, 'amount must be an integer string of QUSD base units'),
  phone: z.string().min(4).max(32),
  email: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  nickname: z.string().max(50).optional(),
})

export async function POST(req: NextRequest) {
  const ip = clientIp(req)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = prepareSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  const { senderAddress, corridorId, phone, email, nickname } = parsed.data
  const sender = senderAddress.toLowerCase() as Hex

  // ── Rate limit: a send is expensive to prepare (chain read + FX + crypto) ──
  const limited = await rateLimit('prepare', sender, { limit: 20, windowSeconds: 3600 })
  if (!limited.success) {
    return NextResponse.json(
      { error: 'Too many send attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfterSeconds) } },
    )
  }

  // ── Corridor must be open ─────────────────────────────────────────────────
  const corridor = getCorridorById(corridorId)
  if (!corridor) {
    return NextResponse.json({ error: `Unknown corridor "${corridorId}"` }, { status: 400 })
  }
  if (!isCorridorOpen(corridor, IS_PRODUCTION_CHAIN)) {
    // This is the guard that makes a silent stub impossible. A corridor with no
    // live payout provider cannot be sent through at all.
    return NextResponse.json(
      {
        error: `The ${corridor.rail} payout rail is not currently available. ` +
               'Please choose another destination.',
        code: 'CORRIDOR_CLOSED',
      },
      { status: 409 },
    )
  }

  // ── Amount ────────────────────────────────────────────────────────────────
  const amount = BigInt(parsed.data.amount)
  if (amount < MIN_AMOUNT_BASE_UNITS) {
    return NextResponse.json(
      { error: `Minimum transfer is ${Number(MIN_AMOUNT_BASE_UNITS) / 1e6} QUSD` },
      { status: 400 },
    )
  }
  if (amount > MAX_AMOUNT_BASE_UNITS) {
    return NextResponse.json(
      { error: `Maximum transfer is ${Number(MAX_AMOUNT_BASE_UNITS) / 1e6} QUSD` },
      { status: 400 },
    )
  }

  const feeAmount = (amount * BigInt(FEE_BPS)) / 10_000n
  const netAmount = amount - feeAmount

  // ── Recipient contact ─────────────────────────────────────────────────────
  const phoneResult = parsePhone(phone, corridor.recvCountry)
  if (!phoneResult.ok) {
    return NextResponse.json({ error: phoneResult.error }, { status: 400 })
  }

  const channel = serverEnv.OTP_CHANNEL
  if (channel === 'email' && !email) {
    return NextResponse.json(
      { error: "The recipient's email address is required to deliver their claim code." },
      { status: 400 },
    )
  }

  // ── FX quote, locked here and honoured at payout ──────────────────────────
  // A null quote means no rate within the staleness bound. Refuse the send
  // rather than quoting on data we cannot vouch for — a transfer that pays out
  // the wrong amount is far worse than one that never starts.
  const quote = await quotePayout(netAmount, corridor.currency, corridor.minorUnits)
  if (!quote) {
    return NextResponse.json(
      {
        error: 'Live exchange rates are temporarily unavailable, so we cannot quote this ' +
               'transfer right now. Please try again in a few minutes.',
        code: 'FX_UNAVAILABLE',
      },
      { status: 503 },
    )
  }

  // ── Serialise preparation per sender ──────────────────────────────────────
  // `transferId` is derived from the sender's on-chain nonce. If two tabs
  // prepare at once they compute the same id, and whichever transaction lands
  // second gets a different one — its commitment would not match and the funds
  // would be unclaimable. The lock makes that impossible.
  const redis = getRedis()
  const lockKey = `lock:prepare:${sender}`
  if (redis) {
    const acquired = await redis.set(lockKey, Date.now(), { nx: true, ex: 180 })
    if (acquired === null) {
      return NextResponse.json(
        {
          error: 'Another transfer from this wallet is still being prepared. ' +
                 'Finish or cancel it before starting a new one.',
          code: 'PREPARE_IN_PROGRESS',
        },
        { status: 409 },
      )
    }
  }

  try {
    // ── Read the authoritative nonce from chain ─────────────────────────────
    // Never trust a client-supplied nonce: it decides the transferId, and a
    // forged one would let a caller overwrite another sender's prepared row.
    const publicClient = createPublicClient({ chain: serverChain, transport: http(env.NEXT_PUBLIC_RPC_URL) })

    let senderNonce: bigint
    try {
      senderNonce = (await publicClient.readContract({
        address: REMITCHAIN_ADDRESS,
        abi: RemitChainAbi,
        functionName: 'senderNonces',
        args: [senderAddress as Hex],
      })) as bigint
    } catch (err) {
      log('error', 'prepare.nonce_read_failed', { err: String(err).slice(0, 200) })
      if (redis) await redis.del(lockKey)
      return NextResponse.json(
        { error: 'Could not reach the QIE network. Please try again.' },
        { status: 502 },
      )
    }

    const transferId = computeTransferId({
      sender: senderAddress as Hex,
      nonce: senderNonce,
      chainId: BigInt(env.NEXT_PUBLIC_CHAIN_ID),
      remitChain: REMITCHAIN_ADDRESS,
    })

    // ── Mint credentials ────────────────────────────────────────────────────
    const { claimSecret, otp } = generateClaimCredentials()
    const recipient = relayerAddress()
    const { otpCommitHash } = deriveCommitment(claimSecret, otp, transferId, recipient)
    const phoneHash = computePhoneHash(phoneResult.e164)

    // ── Persist ─────────────────────────────────────────────────────────────
    if (!db) {
      if (redis) await redis.del(lockKey)
      return NextResponse.json(
        { error: 'Service temporarily unavailable. Please try again shortly.' },
        { status: 503 },
      )
    }

    const now = Date.now()
    await db
      .insert(transfers)
      .values({
        id: transferId,
        txHash: null,
        senderAddress: sender,
        senderNonce: Number(senderNonce),
        recipientPhoneHash: phoneHash,
        recipientPhoneMasked: maskPhone(phoneResult.e164),
        recipientEmail: email ?? null,
        recipientNickname: nickname ?? null,
        amount: amount.toString(),
        feeAmount: feeAmount.toString(),
        netAmount: netAmount.toString(),
        corridor: corridor.id,
        quotedRate: String(quote.rate),
        quotedCurrency: quote.currency,
        quotedLocalMinor: String(quote.amountMinor),
        quotedAt: now,
        claimSecretEnc: encryptSecret(claimSecret),
        otpEnc: encryptSecret(otp),
        status: 0,
        notifyChannel: channel,
        notifyStatus: 'PENDING',
        createdAt: now,
        updatedAt: now,
      })
      // A re-prepare for the same nonce (user backed out and retried) replaces
      // the credentials. Safe: nothing is on-chain yet, so the old commitment
      // was never used.
      .onConflictDoUpdate({
        target: transfers.id,
        set: {
          recipientPhoneHash: phoneHash,
          recipientPhoneMasked: maskPhone(phoneResult.e164),
          recipientEmail: email ?? null,
          recipientNickname: nickname ?? null,
          amount: amount.toString(),
          feeAmount: feeAmount.toString(),
          netAmount: netAmount.toString(),
          corridor: corridor.id,
          quotedRate: String(quote.rate),
          quotedCurrency: quote.currency,
          quotedLocalMinor: String(quote.amountMinor),
          quotedAt: now,
          claimSecretEnc: encryptSecret(claimSecret),
          otpEnc: encryptSecret(otp),
          notifyChannel: channel,
          notifyStatus: 'PENDING',
          updatedAt: now,
        },
        // Never re-key a transfer that has already been broadcast: once funds
        // are locked on-chain against a commitment, replacing it would make
        // them unclaimable.
        setWhere: isNull(transfers.txHash),
      })

    log('info', 'prepare.ok', {
      transferId: transferId.slice(0, 10) + '…',
      corridor: corridor.id,
      amount: amount.toString(),
      quoteSource: quote.source,
    })

    return NextResponse.json({
      transferId,
      // Exactly what the wallet must pass to sendRemittance(), in order.
      sendArgs: {
        recipientPhoneHash: phoneHash,
        amount: amount.toString(),
        otpCommitHash,
        corridor: corridor.index,
      },
      senderNonce: senderNonce.toString(),
      quote: {
        currency: quote.currency,
        rate: quote.rate,
        amountMinor: quote.amountMinor,
        amountDisplay: quote.amountDisplay,
        symbol: corridor.currencySymbol,
        source: quote.source,
      },
      fee: { amount: feeAmount.toString(), bps: FEE_BPS, decimals: QUSD_DECIMALS },
      net: netAmount.toString(),
      recipientPhoneMasked: maskPhone(phoneResult.e164),
      rail: corridor.rail,
      claimUrl: `${appUrl()}/claim/${transferId}`,
    })
  } catch (err) {
    if (redis) await redis.del(lockKey)
    log('error', 'prepare.failed', { err: String(err).slice(0, 300), ip })
    return NextResponse.json(
      { error: 'Could not prepare the transfer. Please try again.' },
      { status: 500 },
    )
  }
}
