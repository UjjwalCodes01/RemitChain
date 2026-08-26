/**
 * hooks/useTransferDetail.ts
 *
 * Fetches a single transfer from /api/transfers/[id].
 * The backend merges on-chain (authoritative) + DB (off-chain metadata).
 * Used by the live tracker page — polled every 5s.
 */

'use client'

import { useQuery } from '@tanstack/react-query'

/** The fiat leg, as returned by the payout ledger. */
export interface PayoutDetail {
  status: 'CREATED' | 'SUBMITTED' | 'PROCESSING' | 'PAID' | 'FAILED' | 'REVERSED' | 'MANUAL_REVIEW'
  rail: string
  currency: string
  amountMinor: string
  destinationMasked: string
  utr: string | null
  reference: string | null
  /** False when a simulated rail serviced this payout. */
  live: boolean
  paidAt: number | null
  updatedAt: number
}

export interface TransferDetail {
  id: string
  // Chain-authoritative
  status: number          // 0=PENDING 1=CLAIMED 2=CANCELLED
  amount: string          // QUSD base units as string
  expiry: number          // epoch ms
  sender: string | null
  onChain: boolean
  awaitingBroadcast?: boolean
  // Money split
  feeAmount: string | null
  netAmount: string | null
  // Off-chain metadata
  txHash: string | null
  claimTxHash: string | null
  recipientNickname: string | null
  recipientPhoneMasked: string | null
  corridor: string | null
  rail: string | null
  quote: {
    rate: string
    currency: string | null
    amountMinor: string | null
    symbol: string
    minorUnits: number
  } | null
  notifyStatus: string    // PENDING/SENT/FAILED
  /** Null until the transfer has been claimed. */
  payout: PayoutDetail | null
  createdAt: number | null
  claimedAt: number | null
  dbAvailable: boolean
}

async function fetchTransferDetail(id: string): Promise<TransferDetail> {
  const res = await fetch(`/api/transfers/${id}`)
  if (!res.ok) throw new Error(`Transfer not found: ${id}`)
  return res.json() as Promise<TransferDetail>
}

export function useTransferDetail(transferId?: string, enabled = true) {
  return useQuery({
    queryKey: ['transfer-detail', transferId],
    queryFn: () => fetchTransferDetail(transferId!),
    enabled: enabled && !!transferId,
    staleTime: 4_000,
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data) return 5_000
      // Cancelled is terminal for everything.
      if (data.status === 2) return false
      // A claimed transfer is NOT finished until its payout settles — keep
      // polling so the recipient sees the fiat leg progress rather than a
      // screen that stops updating the moment the escrow releases.
      if (data.status === 1) {
        const settled =
          data.payout &&
          ['PAID', 'REVERSED', 'MANUAL_REVIEW'].includes(data.payout.status)
        return settled ? false : 5_000
      }
      return 5_000
    },
  })
}
