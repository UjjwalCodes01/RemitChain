/**
 * app/api/kyc/upgrade/route.ts
 * POST /api/kyc/upgrade
 *
 * Raises a wallet's on-chain KYC tier once an identity check has passed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS USED TO BE AN UNAUTHENTICATED TIER-2 GRANT
 * ─────────────────────────────────────────────────────────────────────────────
 * The route accepted `{ userAddress }` from anyone and signed a passOracle
 * attestation raising that address to Tier 2 — a 5,000 QUSD/day allowance —
 * with no verification, no authentication and no rate limit. Any wallet could
 * grant itself the highest limit in the system with one curl.
 *
 * Granting a tier has to be the LAST step of a real identity check, never a
 * self-service endpoint. This route is now a thin adapter over a decision an
 * identity provider has already made. Until one is wired in (`KYC_PROVIDER`),
 * it refuses to grant anything on a production chain.
 *
 * To integrate a provider (Onfido, Sumsub, Persona, QIE Pass, …):
 *   1. Run their hosted flow from /settings and receive their webhook.
 *   2. Verify that webhook's signature in `verifyProviderDecision` below.
 *   3. Map their decision to tier 1 or 2 and let this route sign the grant.
 *
 * Security: RELAYER_PRIVATE_KEY is the passOracle key — server-only, never client-exposed.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { env, IS_PRODUCTION_CHAIN } from '@/lib/env'
import { relayerPrivateKey } from '@/lib/env.server'
import { KYC_REGISTRY_ADDRESS, KYCRegistryAbi } from '@/lib/contracts'
import { serverChain } from '@/lib/chain-config'
import { rateLimit } from '@/lib/ratelimit'
import { clientIp, log } from '@/lib/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Signs and broadcasts verifyUser(), then waits for the receipt.
export const maxDuration = 60

const upgradeSchema = z.object({
  userAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid EVM address'),
  /** Opaque token from the identity provider proving a decision was reached. */
  verificationToken: z.string().min(1).optional(),
})

/**
 * Confirm that an identity provider actually approved this wallet.
 *
 * Returns false until a provider is configured. That is the safe default: with
 * no provider there is no verification, so there is nothing to grant.
 */
async function verifyProviderDecision(
  _userAddress: string,
  _token: string | undefined,
): Promise<boolean> {
  const provider = process.env.KYC_PROVIDER
  if (!provider) return false

  // Integration point. Each provider gets a branch here that validates their
  // signed decision for this specific wallet and tier.
  log('error', 'kyc.unknown_provider', { provider })
  return false
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req)

  const limited = await rateLimit('kyc:upgrade', ip, { limit: 5, windowSeconds: 3600 })
  if (!limited.success) {
    return NextResponse.json({ error: 'Too many requests.' }, { status: 429 })
  }

  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const parsed = upgradeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const { userAddress, verificationToken } = parsed.data
  const user = userAddress as `0x${string}`

  const approved = await verifyProviderDecision(userAddress, verificationToken)

  if (!approved && IS_PRODUCTION_CHAIN) {
    log('warn', 'kyc.upgrade_refused', { ip })
    return NextResponse.json(
      {
        error:
          'Identity verification is required before your sending limit can be raised. ' +
          'Please complete verification from Settings.',
        code: 'VERIFICATION_REQUIRED',
      },
      { status: 403 },
    )
  }
  // Off a production chain there is no real money and no real identity to
  // check, so testers can raise their own tier. Unreachable on mainnet.

  try {
    const account = privateKeyToAccount(relayerPrivateKey())
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
