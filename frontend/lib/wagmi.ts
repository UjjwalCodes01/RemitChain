import { createConfig, http, createStorage, cookieStorage } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { qieTestnet } from './chains'
import { env } from './env'

const connectors = [injected()]

export const wagmiConfig = createConfig({
  chains: [qieTestnet],
  connectors,
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
  transports: {
    [qieTestnet.id]: http(env.NEXT_PUBLIC_RPC_URL),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
