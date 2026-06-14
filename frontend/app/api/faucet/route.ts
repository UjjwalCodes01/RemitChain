/**
 * app/api/faucet/route.ts
 * POST /api/faucet  { address: "0x..." }
 *
 * Drips 100 testnet QUSD to a wallet address.
 * Rate-limited to 1 drip per address per 24h via Redis.
 * Falls back to in-memory rate-limit when Redis is absent.
 *
 * SECURITY: uses RELAYER_PRIVATE_KEY to call QUSD.transfer().
 * The relayer must hold testnet QUSD.
 * (Mint 10,000 QUSD to relayer manually or via MockQUSD.mint().)
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createWalletClient, createPublicClient, http, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getRedis } from '@/lib/db/redis'
import { QUSD_ADDRESS } from '@/lib/contracts'

// Minimal ERC-20 ABI for faucet — only the functions we call
const ERC20TransferAbi = [
  {
    type: 'function', name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'transfer',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const

import { serverChain, RPC_URL } from '@/lib/chain-config'

const DRIP_AMOUNT = parseUnits('100', 6) // 100 QUSD
const COOLDOWN_SECONDS = 24 * 60 * 60   // 24 hours

// In-memory fallback
const inMemoryLimiter = new Map<string, number>()

const addrSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
})

export async function POST(req: NextRequest) {
  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const parsed = addrSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 })
  }
  const { address } = parsed.data

  // Rate limit check
  const rateLimitKey = `faucet:${address.toLowerCase()}`
  const redis = getRedis()

  if (redis) {
    const existing = await redis.get<number>(rateLimitKey)
    if (existing) {
      const ttl = await redis.ttl(rateLimitKey)
      const hoursLeft = Math.ceil(ttl / 3600)
      return NextResponse.json(
        { error: `Already dripped. Come back in ${hoursLeft}h.`, rateLimited: true },
        { status: 429 },
      )
    }
  } else {
    const lastDrip = inMemoryLimiter.get(address.toLowerCase()) ?? 0
    if (Date.now() - lastDrip < COOLDOWN_SECONDS * 1000) {
      return NextResponse.json({ error: 'Already dripped today.', rateLimited: true }, { status: 429 })
    }
  }

  // Validate relayer key
  const pk = process.env.RELAYER_PRIVATE_KEY as `0x${string}` | undefined
  if (!pk) {
    return NextResponse.json({ error: 'Faucet not configured (missing RELAYER_PRIVATE_KEY)' }, { status: 503 })
  }

  const account = privateKeyToAccount(pk)
  const walletClient = createWalletClient({ account, chain: serverChain, transport: http(RPC_URL) })
  const publicClient = createPublicClient({ chain: serverChain, transport: http(RPC_URL) })

  // Check relayer QUSD balance
  try {
    const relayerBalance = await publicClient.readContract({
      address: QUSD_ADDRESS,
      abi: ERC20TransferAbi,
      functionName: 'balanceOf',
      args: [account.address],
    }) as bigint

    if (relayerBalance < DRIP_AMOUNT) {
      console.error('[faucet] Relayer QUSD too low:', relayerBalance.toString())
      return NextResponse.json({ error: 'Faucet is empty. Contact admin.' }, { status: 503 })
    }
  } catch (err) {
    console.warn('[faucet] Could not check relayer balance:', err)
    // Proceed anyway — let the transfer fail with a clear error
  }

  // Execute transfer
  try {
    const txHash = await walletClient.writeContract({
      address: QUSD_ADDRESS,
      abi: ERC20TransferAbi,
      functionName: 'transfer',
      args: [address as `0x${string}`, DRIP_AMOUNT],
    })

    // Record rate limit
    if (redis) {
      await redis.set(rateLimitKey, Date.now(), { ex: COOLDOWN_SECONDS })
    } else {
      inMemoryLimiter.set(address.toLowerCase(), Date.now())
    }

    console.log(JSON.stringify({
      level: 'info', step: 'faucet.drip',
      to: address, amount: '100 QUSD', txHash,
      ts: new Date().toISOString(),
    }))

    return NextResponse.json({ success: true, txHash, amount: 100, unit: 'QUSD' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[faucet] Transfer failed:', msg)
    return NextResponse.json(
      { error: 'Faucet transfer failed. Try again later.', detail: msg.slice(0, 100) },
      { status: 500 },
    )
  }
}
