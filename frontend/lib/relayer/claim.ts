/**
 * lib/relayer/claim.ts
 *
 * Broadcasts `claimRemittance` on behalf of the recipient.
 *
 * SERVER ONLY. The relayer key must never reach a client bundle or a log line.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ON THE TRUST MODEL
 * ─────────────────────────────────────────────────────────────────────────────
 * `claimRemittance` takes a `recipient` address and an EIP-712 signature from
 * that recipient. The contract's intent is a two-key model: even a compromised
 * relayer cannot redirect funds, because it cannot forge the recipient's
 * signature.
 *
 * In this product the recipient has no wallet — that is the entire premise —
 * so the relayer IS the on-chain recipient, and it signs for itself. The
 * two-key property therefore does NOT hold for this deployment: whoever holds
 * the relayer key can release any claimable escrow to that address.
 *
 * This is stated plainly rather than papered over, because it determines where
 * the real control has to sit:
 *
 *   - the relayer key belongs in a KMS/HSM, not an environment variable;
 *   - the relayer address should hold only gas, never accumulate balance;
 *   - releasing escrow does not pay anyone — the payout ledger does, and that
 *     is where reconciliation and limits live.
 *
 * See contracts/THREAT_MODEL.md §3.3 R1/R2 for the full write-up.
 */

import 'server-only'
import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { REMITCHAIN_ADDRESS, RemitChainAbi } from '@/lib/contracts'
import { rpcTransport } from '@/lib/rpc'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ClaimParams {
  transferId: Hex
  otpReveal: Hex
  relayerPrivateKey: Hex
  relayerAddress: Hex
  /** Pin a specific endpoint. Omit to use the configured failover list. */
  rpcUrl?: string
  chain: Chain
}

export interface ClaimResult {
  txHash: Hex
  blockNumber: bigint
}

export interface TransferData {
  sender: Hex
  recipientPhoneHash: Hex
  otpCommitHash: Hex
  amount: bigint
  expiry: bigint
  corridor: number
  status: number
}

/** On-chain `Status` enum. NONE is 0, so a missing transfer reads as NONE. */
export const ChainStatus = {
  NONE: 0,
  PENDING: 1,
  CLAIMED: 2,
  CANCELLED: 3,
} as const

/** Signature validity window. Short, because we broadcast immediately. */
const SIGNATURE_TTL_SECONDS = 300

// ─── Broadcast ───────────────────────────────────────────────────────────────

/**
 * Sign and broadcast `claimRemittance`, then wait for inclusion.
 *
 * Throws on revert or network failure. The caller must treat a throw as "the
 * escrow did NOT release" and must not pay anyone.
 */
export async function buildAndBroadcastClaim(params: ClaimParams): Promise<ClaimResult> {
  const { transferId, otpReveal, relayerPrivateKey, relayerAddress, rpcUrl, chain } = params

  const account = privateKeyToAccount(relayerPrivateKey)
  if (account.address.toLowerCase() !== relayerAddress.toLowerCase()) {
    throw new Error('Relayer private key does not match the configured relayer address')
  }

  // `rpcUrl` is kept in the signature for callers that need to pin an endpoint,
  // but the default path uses the failover transport: broadcasting a claim
  // against a single node means one unreachable host stops every claim.
  const transport = rpcUrl ? http(rpcUrl, { retryCount: 2, timeout: 15_000 }) : rpcTransport()
  const publicClient = createPublicClient({ chain, transport })
  const walletClient = createWalletClient({ account, chain, transport })

  // Replay protection for the EIP-712 payload — increments on every claim.
  const nonce = (await publicClient.readContract({
    address: REMITCHAIN_ADDRESS,
    abi: RemitChainAbi,
    functionName: 'recipientNonces',
    args: [relayerAddress],
  })) as bigint

  const deadline = BigInt(Math.floor(Date.now() / 1000) + SIGNATURE_TTL_SECONDS)

  const signature = await walletClient.signTypedData({
    domain: {
      name: 'RemitChain',
      version: '1',
      chainId: chain.id,
      verifyingContract: REMITCHAIN_ADDRESS,
    },
    types: {
      ClaimRemittance: [
        { name: 'transferId', type: 'bytes32' },
        { name: 'recipient', type: 'address' },
        { name: 'deadline', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'ClaimRemittance',
    message: { transferId, recipient: relayerAddress, deadline, nonce },
  })

  // Simulate first so a revert surfaces as a typed error before we spend gas.
  const { request } = await publicClient.simulateContract({
    account,
    address: REMITCHAIN_ADDRESS,
    abi: RemitChainAbi,
    functionName: 'claimRemittance',
    args: [transferId, otpReveal, relayerAddress, deadline, signature],
  })

  const txHash = await walletClient.writeContract(request)

  // This wait must finish well inside the route's `maxDuration`. If the
  // function is killed here the escrow may still release, which is exactly the
  // orphan case `payoutDestinationEnc` + the payout cron exist to repair — but
  // the recipient sees an error for a claim that actually worked, so keep the
  // budget comfortably under the 60s function limit.
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
    timeout: 40_000,
  })

  if (receipt.status !== 'success') {
    throw new Error(`claimRemittance reverted in transaction ${txHash}`)
  }

  return { txHash, blockNumber: receipt.blockNumber }
}

// ─── Revert mapping ──────────────────────────────────────────────────────────

/**
 * Translate a contract revert into something a recipient can act on.
 * Returns null when the error is not a recognised contract error.
 */
export function mapClaimRevert(message: string): { status: number; error: string } | null {
  if (message.includes('InvalidOTPReveal')) {
    return { status: 400, error: 'That code is not correct. Please check and try again.' }
  }
  if (message.includes('TransferExpired')) {
    return { status: 410, error: 'This transfer has expired and has been returned to the sender.' }
  }
  if (message.includes('TransferNotPending')) {
    return { status: 409, error: 'This transfer has already been claimed or cancelled.' }
  }
  if (message.includes('TransferNotFound')) {
    return { status: 404, error: 'We could not find this transfer.' }
  }
  if (message.includes('SignatureExpired')) {
    return { status: 503, error: 'The request timed out. Please try again.' }
  }
  if (message.includes('EnforcedPause')) {
    return { status: 503, error: 'Claims are temporarily paused. Please try again shortly.' }
  }
  return null
}
