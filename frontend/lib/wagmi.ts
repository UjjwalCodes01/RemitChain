import { createConfig, http, createStorage, cookieStorage } from 'wagmi'
import { injected, walletConnect } from 'wagmi/connectors'
import { qieTestnet } from './chains'
import { env } from './env'

const connectors = [
  injected(),
  walletConnect({ 
    projectId: env.NEXT_PUBLIC_WC_PROJECT_ID || 'your_project_id_here',
    metadata: {
      name: 'RemitChain',
      description: 'Send money home. Not 5% of it.',
      url: 'https://remitchain.app',
      icons: ['https://remitchain.app/icons/icon-192.png'],
    }
  }),
]

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
