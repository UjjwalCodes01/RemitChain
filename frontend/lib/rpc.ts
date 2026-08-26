/**
 * lib/rpc.ts
 *
 * One place that builds the RPC transport, with automatic failover.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY FAILOVER
 * ─────────────────────────────────────────────────────────────────────────────
 * Every read, every send and every claim goes through the chain RPC. The app
 * previously hard-wired a single `NEXT_PUBLIC_RPC_URL` into twelve separate
 * `createPublicClient({ transport: http(...) })` calls, so one unreachable node
 * took the whole product down with no second option and no retry.
 *
 * That is not hypothetical: during the 2026-08-26 review, both
 * `rpc1mainnet.qie.digital` and `rpc2mainnet.qie.digital` refused connections
 * while the explorer on the same domain answered normally.
 *
 * `NEXT_PUBLIC_RPC_URLS` takes a comma-separated list and viem's `fallback`
 * transport moves to the next endpoint when one fails. `NEXT_PUBLIC_RPC_URL`
 * still works and is treated as the first entry, so nothing needs changing to
 * keep the previous behaviour.
 */

import { http, fallback, type Transport } from 'viem'

/** Requests per endpoint before giving up and moving to the next. */
const RETRY_COUNT = 2
const RETRY_DELAY_MS = 300
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Every configured endpoint, in priority order, de-duplicated.
 *
 * Reads `NEXT_PUBLIC_RPC_URL` and `NEXT_PUBLIC_RPC_URLS` as literals so the
 * Next.js build can inline them — a dynamic lookup would leave them undefined
 * in the browser bundle.
 */
export function rpcUrls(): string[] {
  const primary = process.env.NEXT_PUBLIC_RPC_URL
  const list = process.env.NEXT_PUBLIC_RPC_URLS

  const urls = [
    ...(primary ? [primary] : []),
    ...(list ? list.split(',') : []),
  ]
    .map(u => u.trim())
    .filter(Boolean)

  const unique = Array.from(new Set(urls))

  if (unique.length === 0) {
    // Matches the default in lib/env.ts so behaviour is identical when neither
    // variable is set.
    return ['https://rpc1mainnet.qie.digital/']
  }
  return unique
}

/**
 * Transport for the configured chain.
 *
 * A single endpoint still gets retries and a timeout — the previous bare
 * `http(url)` had viem's defaults and no ceiling, so a hanging node could sit
 * on a serverless function until the platform killed it.
 */
export function rpcTransport(): Transport {
  const urls = rpcUrls()

  const transports = urls.map(url =>
    http(url, {
      retryCount: RETRY_COUNT,
      retryDelay: RETRY_DELAY_MS,
      timeout: REQUEST_TIMEOUT_MS,
    }),
  )

  if (transports.length === 1) return transports[0]

  // `rank: false` keeps the declared order rather than reordering by latency:
  // the first entry is the one the operator considers authoritative, and a
  // reordering transport can quietly promote a lagging node.
  return fallback(transports, { rank: false, retryCount: 0 })
}

/** True when more than one endpoint is configured. Surfaced by /api/health. */
export function hasRpcFailover(): boolean {
  return rpcUrls().length > 1
}
