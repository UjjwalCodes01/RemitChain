/**
 * lib/chain-config.ts
 *
 * Single source of truth for the server-side viem chain object.
 * All API routes import from here so the chain always reflects
 * NEXT_PUBLIC_CHAIN_ID — mainnet (1990) or testnet (1983).
 *
 * Never import from 'lib/chains.ts' in server routes — that file
 * imports wagmi which is client-only and will break SSR.
 */

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? '1990')
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://rpc1mainnet.qie.digital/'
const IS_MAINNET = CHAIN_ID === 1990

export const serverChain = {
  id: CHAIN_ID,
  name: IS_MAINNET ? 'QIE Mainnet' : 'QIE Testnet',
  nativeCurrency: { name: 'QIE', symbol: 'QIE', decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
  },
} as const

export { RPC_URL, CHAIN_ID, IS_MAINNET }
