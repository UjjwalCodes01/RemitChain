/**
 * hooks/useTransferHistory.ts
 *
 * Fetches sender's transfer history from /api/transfers.
 * Combines DB metadata with a label map for display.
 */

'use client'

import { useQuery } from '@tanstack/react-query'

export interface TransferSummary {
  id: string
  txHash: string | null
  recipientNickname: string | null
  recipientPhoneHash: string | null
  amount: string
  corridor: string | null
  status: number           // 0=PENDING 1=CLAIMED 2=CANCELLED
  offrampStatus: string    // NONE/PENDING/COMPLETED/FAILED
  offrampMethod: string | null
  smsStatus: string        // PENDING/SENT/FAILED
  createdAt: number | null
  claimedAt: number | null
  expiry: number | null
}

const STATUS_LABELS: Record<number, string> = {
  0: 'Pending',
  1: 'Claimed',
  2: 'Cancelled',
}

export function statusLabel(status: number): string {
  return STATUS_LABELS[status] ?? 'Unknown'
}

export function formatQusd(amountStr: string): string {
  const n = Number(BigInt(amountStr)) / 1_000_000
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

async function fetchTransferHistory(address: string): Promise<TransferSummary[]> {
  const res = await fetch(`/api/transfers?address=${encodeURIComponent(address)}`)
  if (!res.ok) throw new Error('Failed to fetch transfer history')
  const data = await res.json() as { transfers: TransferSummary[] }
  return data.transfers
}

export function useTransferHistory(address?: string) {
  return useQuery({
    queryKey: ['transfer-history', address],
    queryFn: () => fetchTransferHistory(address!),
    enabled: !!address && /^0x[a-fA-F0-9]{40}$/.test(address),
    staleTime: 15_000,      // 15s — dashboard doesn't need real-time
    refetchInterval: 30_000, // refresh every 30s
  })
}
