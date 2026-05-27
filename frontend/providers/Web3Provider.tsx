'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { WagmiProvider, State } from 'wagmi'
import { wagmiConfig } from '@/lib/wagmi'

interface Web3ProviderProps {
  children: React.ReactNode
  initialState?: State
}

export function Web3Provider({ children, initialState }: Web3ProviderProps) {
  // useState lazy initializer guarantees a single QueryClient instance
  // that survives Fast Refresh without accessing refs during render
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      })
  )

  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  )
}
