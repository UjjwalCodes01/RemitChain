'use client'

import { useReadContract } from 'wagmi'
import { KYCRegistryAbi, KYC_REGISTRY_ADDRESS } from '@/lib/contracts'

export type KYCTier = 0 | 1 | 2

interface KYCStatus {
  tier: KYCTier
  isLoading: boolean
  error: Error | null
  tierLabel: string
  dailyLimit: string
}

const TIER_LABELS: Record<KYCTier, string> = {
  0: 'Unverified',
  1: 'Phone Verified',
  2: 'Full ID',
}

const DAILY_LIMITS: Record<KYCTier, string> = {
  0: 'No limit',
  1: '$500 / day',
  2: '$5,000 / day',
}

export function useKYCStatus(address?: `0x${string}`): KYCStatus {
  const {
    data,
    isLoading,
    error,
  } = useReadContract({
    address: KYC_REGISTRY_ADDRESS,
    abi: KYCRegistryAbi,
    functionName: 'getKYCLevel',
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(address),
      staleTime: 60_000,
    },
  })

  const tier = (data as KYCTier | undefined) ?? 0

  return {
    tier,
    isLoading,
    error: error as Error | null,
    tierLabel: TIER_LABELS[tier],
    dailyLimit: DAILY_LIMITS[tier],
  }
}
