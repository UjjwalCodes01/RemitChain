import { defineChain } from 'viem'

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
    },
  },
  testnet: true,
})
