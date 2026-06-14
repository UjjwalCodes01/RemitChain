import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createPublicClient, createWalletClient, http, toHex, hexToSignature, decodeEventLog } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { env } from '@/lib/env'
import { REMITCHAIN_ADDRESS, RemitChainAbi } from '@/lib/contracts'

const requestSchema = z.object({
  transferId: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid transferId'),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be exactly 6 digits'),
})

import { serverChain } from '@/lib/chain-config'


export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const parsed = requestSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parsed.error.issues },
        { status: 400 }
      )
    }

    const { transferId, otp } = parsed.data
    const otpReveal = toHex(BigInt(otp), { size: 32 })
    const transferIdHex = transferId as `0x${string}`

    if (!env.RELAYER_PRIVATE_KEY || !env.NEXT_PUBLIC_RELAYER_ADDRESS) {
      console.error('Relayer environment variables are missing.')
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }

    const account = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as `0x${string}`)
    const relayerAddress = env.NEXT_PUBLIC_RELAYER_ADDRESS as `0x${string}`

    if (account.address.toLowerCase() !== relayerAddress.toLowerCase()) {
      console.error('Relayer private key does not match public address.')
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }

    const publicClient = createPublicClient({ chain: serverChain, transport: http(env.NEXT_PUBLIC_RPC_URL) })
    const walletClient = createWalletClient({ account, chain: serverChain, transport: http(env.NEXT_PUBLIC_RPC_URL) })

    // 1. Fetch Transfer Status
    const transfer = await publicClient.readContract({
      address: REMITCHAIN_ADDRESS,
      abi: RemitChainAbi,
      functionName: 'getTransfer',
      args: [transferIdHex],
    })

    if (transfer.status !== 0) { // 0 = PENDING
      return NextResponse.json({ error: 'Transfer is not pending' }, { status: 400 })
    }

    if (BigInt(Math.floor(Date.now() / 1000)) > transfer.expiry) {
      return NextResponse.json({ error: 'Transfer has expired' }, { status: 400 })
    }

    // 2. Fetch Recipient Nonce
    const nonce = await publicClient.readContract({
      address: REMITCHAIN_ADDRESS,
      abi: RemitChainAbi,
      functionName: 'recipientNonces',
      args: [relayerAddress],
    })

    // 3. Generate EIP-712 Signature
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300) // 5 minutes

    const signature = await walletClient.signTypedData({
      domain: {
        name: 'RemitChain',
        version: '1',
        chainId: serverChain.id,
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
        transferId: transferIdHex,
        recipient: relayerAddress,
        deadline,
        nonce,
      },
    })

    // Wait wait... looking at `RemitChain.sol`, does `claimRemittance` require standard `bytes` signature (r, s, v combined)?
    // Viem's `signTypedData` returns the standard `0x...` combined signature which we can pass as `bytes calldata`.

    // 4. Broadcast claimRemittance
    const { request } = await publicClient.simulateContract({
      account,
      address: REMITCHAIN_ADDRESS,
      abi: RemitChainAbi,
      functionName: 'claimRemittance',
      args: [transferIdHex, otpReveal, relayerAddress, deadline, signature],
    })

    const txHash = await walletClient.writeContract(request)

    // Optional: wait for receipt if we want to ensure it's mined
    await publicClient.waitForTransactionReceipt({ hash: txHash })

    return NextResponse.json({ success: true, txHash })

  } catch (err: unknown) {
    console.error('Relayer error:', err)
    
    // Check if it's a known contract error like InvalidOTPReveal
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('InvalidOTPReveal')) {
      return NextResponse.json({ error: 'Invalid OTP' }, { status: 400 })
    }
    
    return NextResponse.json({ error: 'Failed to process claim. Ensure OTP is correct.' }, { status: 500 })
  }
}
