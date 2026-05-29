import { createConfig, http, createStorage, cookieStorage } from 'wagmi'
import { injected, walletConnect } from 'wagmi/connectors'
import { qieTestnet } from './chains'
import { env } from './env'

// Safely build connectors — WalletConnect can throw if projectId is missing or
// the internal session cache is empty on first load (Object.values on null).
function buildConnectors() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list: any[] = [injected()]
  const wcProjectId = env.NEXT_PUBLIC_WC_PROJECT_ID
  if (wcProjectId && wcProjectId !== 'your_project_id_here') {
    try {
      list.push(
        walletConnect({
          projectId: wcProjectId,
          metadata: {
            name: 'RemitChain',
            description: 'Pay anyone, anywhere, by phone number. Near-zero fees.',
            url: typeof window !== 'undefined' ? window.location.origin : 'https://remitchain.app',
            icons: ['https://remitchain.app/icons/icon-192.png'],
          },
          showQrModal: true,
        }),
      )
    } catch (e) {
      console.warn('[wagmi] WalletConnect init failed — injected only:', e)
    }
  }
  return list
}

const connectors = buildConnectors()

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
