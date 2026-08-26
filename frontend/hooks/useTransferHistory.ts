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
  claimTxHash: string | null
  recipientNickname: string | null
  recipientPhoneMasked: string | null
  amount: string
  netAmount: string | null
  corridor: string | null
  status: number           // 0=PENDING 1=CLAIMED 2=CANCELLED
  notifyStatus: string     // PENDING/SENT/FAILED
  quotedRate: string | null
  quotedCurrency: string | null
  quotedLocalMinor: string | null
  createdAt: number | null
  claimedAt: number | null
  expiry: number | null
  // Joined from the payout ledger; null until claimed.
  payoutStatus: string | null
  payoutRail: string | null
  payoutDestinationMasked: string | null
  payoutUtr: string | null
}

/** Human label for the fiat leg. */
export function payoutLabel(status: string | null): string {
  switch (status) {
    case 'PAID': return 'Paid out'
    case 'PROCESSING':
    case 'SUBMITTED': return 'Paying out…'
    case 'CREATED': return 'Queued'
    case 'FAILED': return 'Retrying'
    case 'REVERSED': return 'Returned'
    case 'MANUAL_REVIEW': return 'Needs review'
    default: return ''
  }
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
