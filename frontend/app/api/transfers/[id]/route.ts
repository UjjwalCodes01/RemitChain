/**
 * GET /api/transfers/[id]
 *
 * A single transfer: on-chain state (authoritative for money) merged with the
 * off-chain record (metadata, notification status) and the payout ledger.
 *
 * Polled by the tracker page, so it stays cheap and never returns anything
 * secret — no OTP, no claim secret, no full phone number, no full payout
 * destination.
 */

import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { createPublicClient, http, type Hex } from 'viem'
import { REMITCHAIN_ADDRESS, RemitChainAbi } from '@/lib/contracts'
import { db, transfers } from '@/lib/db'
import { serverChain, RPC_URL } from '@/lib/chain-config'
import { getCorridorById, getCorridorByIndex } from '@/lib/corridors'
import { getPayoutForTransfer, toPublicPayout } from '@/lib/payouts/ledger'
import { ChainStatus } from '@/lib/relayer/claim'
import { rpcTransport } from '@/lib/rpc'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** On-chain Status → the DB's 0=PENDING / 1=CLAIMED / 2=CANCELLED encoding. */
function mapChainStatusToDb(chainStatus: number): number {
  if (chainStatus === ChainStatus.PENDING) return 0
  if (chainStatus === ChainStatus.CLAIMED) return 1
  if (chainStatus === ChainStatus.CANCELLED) return 2
  return 0
}

interface ChainTransfer {
  sender: string
  recipientPhoneHash: string
  otpCommitHash: string
  amount: bigint
  expiry: bigint
  corridor: number
  status: number
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const transferId = id.startsWith('0x') ? id : `0x${id}`

  if (!/^0x[a-fA-F0-9]{64}$/.test(transferId)) {
    return NextResponse.json({ error: 'Invalid transfer reference' }, { status: 400 })
  }

  const [dbResult, chainResult, payoutResult] = await Promise.allSettled([
    db
      ? db.select().from(transfers).where(eq(transfers.id, transferId)).limit(1)
      : Promise.resolve([]),
    createPublicClient({ chain: serverChain, transport: rpcTransport() }).readContract({
      address: REMITCHAIN_ADDRESS,
      abi: RemitChainAbi,
      functionName: 'getTransfer',
      args: [transferId as Hex],
    }),
    getPayoutForTransfer(transferId),
  ])

  const dbRow = dbResult.status === 'fulfilled' ? (dbResult.value[0] ?? null) : null
  let chain = chainResult.status === 'fulfilled' ? (chainResult.value as unknown as ChainTransfer) : null

  // Status NONE means the id has never existed on this chain.
  if (chain && chain.status === ChainStatus.NONE) chain = null

  if (!chain) {
    // A prepared-but-not-yet-broadcast transfer legitimately has no chain
    // state. Report it as pending rather than 404, so the sender's tracker
    // works during the seconds between signing and inclusion.
    if (dbRow && !dbRow.txHash) {
      return NextResponse.json(
        {
          id: transferId,
          status: 0,
          onChain: false,
          awaitingBroadcast: true,
          amount: dbRow.amount,
          corridor: dbRow.corridor,
          createdAt: dbRow.createdAt,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }
    return NextResponse.json({ error: 'Transfer not found on the configured network' }, { status: 404 })
  }

  const corridor = getCorridorById(dbRow?.corridor ?? '') ?? getCorridorByIndex(chain.corridor)
  const payout = payoutResult.status === 'fulfilled' ? payoutResult.value : null

  return NextResponse.json(
    {
      id: transferId,

      // Chain is authoritative for anything financial.
      status: mapChainStatusToDb(chain.status),
      amount: chain.amount.toString(),
      // Emitted in seconds; every timestamp this API returns is epoch ms.
      expiry: Number(chain.expiry) * 1000,
      sender: chain.sender,
      onChain: true,

      // Derived money split.
      feeAmount: dbRow?.feeAmount ?? null,
      netAmount: dbRow?.netAmount ?? null,

      // Off-chain metadata.
      txHash: dbRow?.txHash ?? null,
      claimTxHash: dbRow?.claimTxHash ?? null,
      recipientNickname: dbRow?.recipientNickname ?? null,
      recipientPhoneMasked: dbRow?.recipientPhoneMasked ?? null,
      corridor: corridor?.id ?? null,
      rail: corridor?.rail ?? null,

      // The rate quoted to the sender, honoured at payout time.
      quote: dbRow?.quotedRate
        ? {
            rate: dbRow.quotedRate,
            currency: dbRow.quotedCurrency,
            amountMinor: dbRow.quotedLocalMinor,
            symbol: corridor?.currencySymbol ?? '',
            minorUnits: corridor?.minorUnits ?? 100,
          }
        : null,

      notifyStatus: dbRow?.notifyStatus ?? 'PENDING',

      // The fiat leg. Null until the transfer has been claimed.
      payout: payout ? toPublicPayout(payout) : null,

      createdAt: dbRow?.createdAt ?? null,
      claimedAt: dbRow?.claimedAt ?? null,
      dbAvailable: db !== null,
    },
    // Short cache: the tracker polls this, but a stale claim status is
    // confusing, so keep the window tight.
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
