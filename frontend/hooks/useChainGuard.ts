'use client'

import { useChainId, useSwitchChain } from 'wagmi'
import { qieTestnet } from '@/lib/chains'

interface ChainGuard {
  wrongChain: boolean
  targetChainName: string
  switchChain: () => void
  isSwitching: boolean
}

export function useChainGuard(): ChainGuard {
  const chainId = useChainId()
  const { switchChain, isPending } = useSwitchChain()

  const wrongChain = chainId !== qieTestnet.id

  function handleSwitch() {
    switchChain({ chainId: qieTestnet.id })
  }

  return {
    wrongChain,
    targetChainName: qieTestnet.name,
    switchChain: handleSwitch,
    isSwitching: isPending,
  }
}
