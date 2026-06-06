import { defineChain } from 'viem'
import { env } from '@/lib/env'

export const qieTestnet = defineChain({
  id: 1983,
  name: 'QIE Testnet',
  nativeCurrency: { name: 'QIE', symbol: 'QIE', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc1testnet.qie.digital/'] },
    public: { http: ['https://rpc1testnet.qie.digital/'] },
  },
  blockExplorers: {
    default: {
      name: 'QIE Explorer',
      url: 'https://testnet.qie.digital',
      apiUrl: 'https://testnet.qie.digital/api',
    },
  },
  testnet: true,
})

export const qieMainnet = defineChain({
  id: 1990,
  name: 'QIE',
  nativeCurrency: { name: 'QIE', symbol: 'QIE', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc1mainnet.qie.digital/'] },
    public: {
      http: [
        'https://rpc1mainnet.qie.digital/',
        'https://rpc2mainnet.qie.digital/',
      ],
    },
  },
  blockExplorers: {
    default: {
      name: 'QIE Explorer',
      url: 'https://mainnet.qie.digital',
      apiUrl: 'https://mainnet.qie.digital/api',
    },
  },
  testnet: false,
})

/** The chain that is active for this deployment, selected by NEXT_PUBLIC_CHAIN_ID. */
export const activeChain =
  env.NEXT_PUBLIC_CHAIN_ID === qieMainnet.id
    ? qieMainnet
    : qieTestnet
