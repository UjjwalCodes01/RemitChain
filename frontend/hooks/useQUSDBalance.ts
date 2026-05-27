'use client'

import { useReadContract } from 'wagmi'
import { formatUnits } from 'viem'
import { ERC20Abi, QUSD_ADDRESS, QUSD_DECIMALS } from '@/lib/contracts'

interface QUSDBalance {
  formatted: string
  raw: bigint
  isLoading: boolean
  error: Error | null
}

export function useQUSDBalance(address?: `0x${string}`): QUSDBalance {
  const {
    data: raw,
    isLoading,
    error,
  } = useReadContract({
    address: QUSD_ADDRESS,
    abi: ERC20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(address),
      refetchInterval: 15_000,
    },
  })

  // Avoid BigInt literal syntax (0n) for broader TS target compatibility
  const rawBigInt: bigint = raw !== undefined ? raw : BigInt(0)
  const hasBalance = rawBigInt > BigInt(0)
  const formatted = hasBalance
    ? formatUnits(rawBigInt, QUSD_DECIMALS)
    : '0.000000'

  return {
    formatted,
    raw: rawBigInt,
    isLoading,
    error: error as Error | null,
  }
}
