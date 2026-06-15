/**
 * app/api/debug/relayer/route.ts
 *
 * TEMPORARY debug endpoint — shows relayer health and what error
 * the claim route would produce. Remove before final submission.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { serverChain } from '@/lib/chain-config'
import { env } from '@/lib/env'
import { REMITCHAIN_ADDRESS, RemitChainAbi } from '@/lib/contracts'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const results: Record<string, unknown> = {}

  // 1. Check env vars
  results.hasRelayerKey = !!env.RELAYER_PRIVATE_KEY
  results.hasRelayerAddress = !!env.NEXT_PUBLIC_RELAYER_ADDRESS
  results.chainId = env.NEXT_PUBLIC_CHAIN_ID
  results.rpcUrl = env.NEXT_PUBLIC_RPC_URL
  results.relayerAddress = env.NEXT_PUBLIC_RELAYER_ADDRESS

  // 2. Verify key matches address
  if (env.RELAYER_PRIVATE_KEY) {
    try {
      const account = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as `0x${string}`)
      results.derivedAddress = account.address
      results.keyMatchesAddress =
        account.address.toLowerCase() === (env.NEXT_PUBLIC_RELAYER_ADDRESS ?? '').toLowerCase()
    } catch (e) {
      results.keyError = String(e)
    }
  }

  // 3. Check relayer QIE balance
  try {
    const publicClient = createPublicClient({
      chain: serverChain,
      transport: http(env.NEXT_PUBLIC_RPC_URL),
    })
    const balance = await publicClient.getBalance({
      address: env.NEXT_PUBLIC_RELAYER_ADDRESS as `0x${string}`,
    })
    results.relayerBalanceQIE = formatEther(balance)
    results.hasSufficientGas = balance >= BigInt('10000000000000000') // 0.01 QIE

    // 4. Check contract is reachable - read a simple value
    try {
      const nonce = await publicClient.readContract({
        address: REMITCHAIN_ADDRESS,
        abi: RemitChainAbi,
        functionName: 'recipientNonces',
        args: [env.NEXT_PUBLIC_RELAYER_ADDRESS as `0x${string}`],
      })
      results.relayerOnChainNonce = nonce?.toString()
      results.contractReachable = true
    } catch (e) {
      results.contractReachable = false
      results.contractError = String(e).slice(0, 300)
    }
  } catch (e) {
    results.balanceError = String(e).slice(0, 300)
  }

  // 5. Check optional transfer status if transferId provided
  const transferId = req.nextUrl.searchParams.get('transferId')
  if (transferId) {
    try {
      const publicClient = createPublicClient({
        chain: serverChain,
        transport: http(env.NEXT_PUBLIC_RPC_URL),
      })
      const transfer = await publicClient.readContract({
        address: REMITCHAIN_ADDRESS,
        abi: RemitChainAbi,
        functionName: 'getTransfer',
        args: [transferId as `0x${string}`],
      }) as Record<string, unknown>
      results.transfer = {
        status: transfer?.status,
        amount: transfer?.amount?.toString(),
        expiry: transfer?.expiry?.toString(),
        sender: transfer?.sender,
      }
    } catch (e) {
      results.transferError = String(e).slice(0, 300)
    }
  }

  return NextResponse.json(results, { status: 200 })
}
