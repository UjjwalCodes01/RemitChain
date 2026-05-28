/**
 * hooks/useTransferDetail.ts
 *
 * Fetches a single transfer from /api/transfers/[id].
 * The backend merges on-chain (authoritative) + DB (off-chain metadata).
 * Used by the live tracker page — polled every 5s.
 */

'use client'

import { useQuery } from '@tanstack/react-query'

export interface TransferDetail {
  id: string
  // Chain-authoritative fields
  status: number          // 0=PENDING 1=CLAIMED 2=CANCELLED
  amount: string          // bigint as string
  expiry: string          // bigint (unix s) as string
  sender: string | null
  recipientPhoneHash: string | null
  // DB off-chain fields
  txHash: string | null
  recipientNickname: string | null
  corridor: string | null
  offrampStatus: string   // NONE/PENDING/COMPLETED/FAILED
  offrampMethod: string | null
  smsStatus: string       // PENDING/SENT/FAILED
  createdAt: number | null
  claimedAt: number | null
  // Availability flags (for UI degradation hints)
  dbAvailable: boolean
  chainAvailable: boolean
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
      // Stop polling once claimed or cancelled
      const data = query.state.data
      if (data?.status === 1 || data?.status === 2) return false
      return 5_000 // poll every 5s while pending
    },
  })
}
