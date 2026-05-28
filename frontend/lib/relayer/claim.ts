/**
 * lib/relayer/claim.ts
 *
 * Shared broadcast helper for the relayer — extracted so it can be
 * unit-tested independently of the HTTP layer.
 *
 * SECURITY: This module is server-only. RELAYER_PRIVATE_KEY must never
 * appear in client bundles or log output.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  toHex,
  encodePacked,
  encodeAbiParameters,
  keccak256,
  type Chain,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { REMITCHAIN_ADDRESS, RemitChainAbi } from '@/lib/contracts'

// ── Constants ────────────────────────────────────────────────────────────────

/** Must match BaseTest.sol and the send page */
export const PHONE_SALT = toHex(BigInt('0xDEADBEEF'), { size: 32 }) as `0x${string}`

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClaimParams {
  transferId: `0x${string}`
  otpReveal: `0x${string}`
  relayerPrivateKey: `0x${string}`
  relayerAddress: `0x${string}`
  rpcUrl: string
  chain: Chain
}

export interface ClaimResult {
  txHash: `0x${string}`
}

export interface TransferData {
  sender: `0x${string}`
  recipientPhoneHash: `0x${string}`
  otpCommitHash: `0x${string}`
  amount: bigint
  expiry: bigint
  corridor: number
  status: number
}

// ── Phone hash ───────────────────────────────────────────────────────────────

/**
 * Compute the phone hash the same way the send page and Solidity do:
 * keccak256(abi.encodePacked(SALT, phone))  (tight packing, no padding)
 */
export function computePhoneHash(phone: string): `0x${string}` {
  return keccak256(encodePacked(['bytes32', 'string'], [PHONE_SALT, phone]))
}

// ── OTP commit hash ──────────────────────────────────────────────────────────

/**
 * Compute the OTP commit hash the same way the send page does:
 * keccak256(abi.encode(otpReveal, transferId, relayerAddress))
 */
export function computeOtpCommitHash(
  otpReveal: `0x${string}`,
  transferId: `0x${string}`,
  relayerAddress: `0x${string}`,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }],
      [otpReveal, transferId, relayerAddress],
    ),
  )
}

// ── Broadcast ────────────────────────────────────────────────────────────────

/**
 * Sign and broadcast claimRemittance() on behalf of the recipient.
 * Throws on contract revert or network error.
 */
export async function buildAndBroadcastClaim(params: ClaimParams): Promise<ClaimResult> {
  const { transferId, otpReveal, relayerPrivateKey, relayerAddress, rpcUrl, chain } = params

  const account = privateKeyToAccount(relayerPrivateKey)

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) })

  // Fetch recipient nonce for EIP-712 replay protection
  const nonce = await publicClient.readContract({
    address: REMITCHAIN_ADDRESS,
    abi: RemitChainAbi,
    functionName: 'recipientNonces',
    args: [relayerAddress],
  })

  // 5-minute deadline
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)

  // EIP-712 signature authorising the relayer to claim on behalf of recipient
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
    message: {
      transferId,
      recipient: relayerAddress,
      deadline,
      nonce,
    },
  })

  // Simulate first to surface revert reasons early
  const { request } = await publicClient.simulateContract({
    account,
    address: REMITCHAIN_ADDRESS,
    abi: RemitChainAbi,
    functionName: 'claimRemittance',
    args: [transferId, otpReveal, relayerAddress, deadline, signature],
  })

  const txHash = await walletClient.writeContract(request)

  // Wait for inclusion — 1 confirmation is enough for demo
  await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 })

  return { txHash }
}
