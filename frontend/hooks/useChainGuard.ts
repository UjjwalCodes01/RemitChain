'use client'

import { useChainId, useSwitchChain } from 'wagmi'
import { activeChain } from '@/lib/chains'

interface ChainGuard {
  wrongChain: boolean
  targetChainName: string
  switchChain: () => void
  isSwitching: boolean
}

export function useChainGuard(): ChainGuard {
  const chainId = useChainId()
  const { switchChain, isPending } = useSwitchChain()

  const wrongChain = chainId !== activeChain.id

  function handleSwitch() {
    switchChain({ chainId: activeChain.id })
  }

  return {
    wrongChain,
    targetChainName: activeChain.name,
    switchChain: handleSwitch,
    isSwitching: isPending,
  }
}
