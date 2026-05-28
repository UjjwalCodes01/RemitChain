/**
 * app/api/transfers/[id]/route.ts
 * GET /api/transfers/[id]
 *
 * Returns a single transfer — merged from DB (off-chain) + chain (authoritative).
 * The chain read is the source of truth for status/expiry/amount.
 * The DB adds: nickname, SMS status, off-ramp status, tx hash.
 *
 * Used by the live tracker page (polled every 5s).
 * Cache-Control: s-maxage=5 for edge caching.
 */

import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { createPublicClient, http } from 'viem'
import { REMITCHAIN_ADDRESS, RemitChainAbi } from '@/lib/contracts'
import { db, transfers } from '@/lib/db'

const qieChain = {
  id: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? '1983'),
  name: 'QIE Testnet',
  nativeCurrency: { name: 'QIE', symbol: 'QIE', decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_RPC_URL ?? 'https://rpc1testnet.qie.digital/'] } },
} as const

export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const transferId = id.startsWith('0x') ? id : `0x${id}`

  if (!/^0x[a-fA-F0-9]{64}$/.test(transferId)) {
    return NextResponse.json({ error: 'Invalid transferId' }, { status: 400 })
  }

  // Fetch DB row and chain status in parallel
  const [dbRows, onChain] = await Promise.allSettled([
    db
      ? db.select().from(transfers).where(eq(transfers.id, transferId)).limit(1)
      : Promise.resolve([]),
    createPublicClient({ chain: qieChain, transport: http() }).readContract({
      address: REMITCHAIN_ADDRESS,
      abi: RemitChainAbi,
      functionName: 'getTransfer',
      args: [transferId as `0x${string}`],
    }),
  ])

  const dbRow = dbRows.status === 'fulfilled' ? dbRows.value[0] ?? null : null
  const chainTransfer = onChain.status === 'fulfilled' ? onChain.value : null

  if (!dbRow && !chainTransfer) {
    return NextResponse.json({ error: 'Transfer not found' }, { status: 404 })
  }

  // Merge: chain is authoritative for financial fields
  const merged = {
    id: transferId,
    // Chain fields (authoritative)
    status: (chainTransfer as { status?: number } | null)?.status ?? dbRow?.status ?? 0,
    amount: ((chainTransfer as { amount?: bigint } | null)?.amount ?? BigInt(dbRow?.amount ?? '0')).toString(),
    expiry: ((chainTransfer as { expiry?: bigint } | null)?.expiry ?? BigInt(dbRow?.expiry ?? '0')).toString(),
    sender: (chainTransfer as { sender?: string } | null)?.sender ?? dbRow?.senderAddress ?? null,
    recipientPhoneHash: (chainTransfer as { recipientPhoneHash?: string } | null)?.recipientPhoneHash ?? dbRow?.recipientPhoneHash ?? null,
    // DB fields (off-chain metadata)
    txHash: dbRow?.txHash ?? null,
    recipientNickname: dbRow?.recipientNickname ?? null,
    corridor: dbRow?.corridor ?? ((chainTransfer as { corridor?: number } | null)?.corridor?.toString() ?? null),
    offrampStatus: dbRow?.offrampStatus ?? 'NONE',
    offrampMethod: dbRow?.offrampMethod ?? null,
    smsStatus: dbRow?.smsStatus ?? 'PENDING',
    createdAt: dbRow?.createdAt ?? null,
    claimedAt: dbRow?.claimedAt ?? null,
    dbAvailable: db !== null,
    chainAvailable: chainTransfer !== null,
  }

  return NextResponse.json(merged, {
    headers: { 'Cache-Control': 's-maxage=5, stale-while-revalidate=10' },
  })
}
