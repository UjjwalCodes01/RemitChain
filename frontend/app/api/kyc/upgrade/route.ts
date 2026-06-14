/**
 * app/api/kyc/upgrade/route.ts
 * POST /api/kyc/upgrade
 *
 * Demo/hackathon oracle: upgrades a wallet to KYC Tier 2 ("Full ID").
 *
 * In production this would require real identity verification.
 * For the testnet demo, the deployer IS the passOracle, so we can sign
 * the attestation server-side and submit the verifyUser() tx directly.
 *
 * Security: RELAYER_PRIVATE_KEY is the passOracle key — server-only, never client-exposed.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { env } from '@/lib/env'
import { KYC_REGISTRY_ADDRESS, KYCRegistryAbi } from '@/lib/contracts'
import { serverChain } from '@/lib/chain-config'

const upgradeSchema = z.object({
  userAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid EVM address'),
})



export async function POST(req: NextRequest) {
  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const parsed = upgradeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const { userAddress } = parsed.data
  const user = userAddress as `0x${string}`

  if (!env.RELAYER_PRIVATE_KEY) {
    return NextResponse.json({ error: 'Oracle not configured' }, { status: 500 })
  }

  try {
    const account = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as `0x${string}`)
    const publicClient = createPublicClient({ chain: serverChain, transport: http(env.NEXT_PUBLIC_RPC_URL) })
    const walletClient = createWalletClient({ account, chain: serverChain, transport: http(env.NEXT_PUBLIC_RPC_URL) })

    // Read user's current KYC level — don't downgrade
    const currentLevel = await publicClient.readContract({
      address: KYC_REGISTRY_ADDRESS,
      abi: KYCRegistryAbi,
      functionName: 'getKYCLevel',
      args: [user],
    }) as number

    if (currentLevel >= 2) {
      return NextResponse.json({ ok: true, message: 'Already at Full ID tier', tier: 2 })
    }

    // Read current nonce for the user (replay protection)
    const nonce = await publicClient.readContract({
      address: KYC_REGISTRY_ADDRESS,
      abi: KYCRegistryAbi,
      functionName: 'nonces',
      args: [user],
    }) as bigint

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600) // 10-min window
    const newLevel = 2

    // Build EIP-712 VerifyUser attestation — passOracle signs it
    const signature = await walletClient.signTypedData({
      domain: {
        name: 'KYCRegistry',
        version: '1',
        chainId: serverChain.id,
        verifyingContract: KYC_REGISTRY_ADDRESS,
      },
      types: {
        VerifyUser: [
          { name: 'user',     type: 'address' },
          { name: 'newLevel', type: 'uint8'   },
          { name: 'deadline', type: 'uint256' },
          { name: 'nonce',    type: 'uint256' },
        ],
      },
      primaryType: 'VerifyUser',
      message: { user, newLevel, deadline, nonce },
    })

    // Simulate then broadcast verifyUser()
    const { request } = await publicClient.simulateContract({
      account,
      address: KYC_REGISTRY_ADDRESS,
      abi: KYCRegistryAbi,
      functionName: 'verifyUser',
      args: [user, newLevel, deadline, signature],
    })

    const txHash = await walletClient.writeContract(request)
    await publicClient.waitForTransactionReceipt({ hash: txHash })

    console.log(JSON.stringify({ level: 'info', step: 'kyc.upgraded', user, tier: 2, txHash }))
    return NextResponse.json({ ok: true, tier: 2, txHash })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[kyc/upgrade] error:', msg.slice(0, 300))
    return NextResponse.json({ error: 'Upgrade failed', detail: msg.slice(0, 200) }, { status: 500 })
  }
}
