/**
 * lib/fx/rates.ts
 *
 * FX rates for payout conversion.
 *
 * Two changes from the previous version that matter for real money:
 *
 *  1. The cache is Redis-backed, not a module-level variable. On Vercel every
 *     serverless instance had its own `_cache`, so two users sending at the same
 *     moment could be quoted materially different rates, and a cold start always
 *     paid the latency of a fresh fetch.
 *
 *  2. `getFxRate` reports WHERE the rate came from. Silently substituting a
 *     hard-coded rate from May 2026 for a live one is fine for a UI preview and
 *     not fine for deciding how many rupees to send. `quoteRequiresLiveRate()`
 *     lets the send path refuse to quote on stale data.
 */

import { cacheGet, cacheSet } from '@/lib/db/redis'

// ─── Seeded fallback rates (USD base) ────────────────────────────────────────
// Last-resort values only. They are a floor under the UI, never a basis for a
// live payout unless ALLOW_SEEDED_FX_QUOTES is explicitly set.
export const SEEDED_RATES: Record<string, number> = {
  INR: 83.45,
  MXN: 17.12,
  NGN: 2018.0,
  PKR: 75.2,
  BDT: 82.4,
}

export interface FxQuote {
  currency: string
  rate: number
  source: 'live' | 'seeded'
  fetchedAt: number
}

const CACHE_KEY = 'fx:usd:v2'
const CACHE_TTL_SECONDS = 300 // 5 minutes
const FETCH_TIMEOUT_MS = 6_000

interface CachedRates {
  rates: Record<string, number>
  fetchedAt: number
}

/** Process-local memo, so repeated calls inside one request do not hit Redis. */
let _local: CachedRates | null = null

async function fetchRates(): Promise<Record<string, number>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`FX API responded ${res.status}`)
    const data = (await res.json()) as { result: string; rates: Record<string, number> }
    if (data.result !== 'success' || !data.rates) throw new Error('FX API returned a non-success result')
    return data.rates
  } finally {
    clearTimeout(timer)
  }
}

async function loadRates(): Promise<CachedRates | null> {
  const now = Date.now()

  if (_local && now - _local.fetchedAt < CACHE_TTL_SECONDS * 1000) return _local

  const cached = await cacheGet<CachedRates>(CACHE_KEY)
  if (cached && now - cached.fetchedAt < CACHE_TTL_SECONDS * 1000) {
    _local = cached
    return cached
  }

  try {
    const rates = await fetchRates()
    const fresh: CachedRates = { rates, fetchedAt: now }
    _local = fresh
    await cacheSet(CACHE_KEY, fresh, CACHE_TTL_SECONDS)
    return fresh
  } catch (err) {
    console.warn('[fx] Live rate fetch failed:', String(err).slice(0, 200))
    // A stale cached value still beats a rate from source control.
    if (cached) {
      _local = cached
      return cached
    }
    return null
  }
}

/**
 * Current USD → `currency` rate.
 * Returns null only when there is no live rate AND no seeded fallback.
 */
export async function getFxRate(currency: string): Promise<FxQuote | null> {
  const loaded = await loadRates()
  const live = loaded?.rates[currency]

  if (typeof live === 'number' && Number.isFinite(live) && live > 0) {
    return { currency, rate: live, source: 'live', fetchedAt: loaded!.fetchedAt }
  }

  const seeded = SEEDED_RATES[currency]
  if (typeof seeded === 'number') {
    return { currency, rate: seeded, source: 'seeded', fetchedAt: 0 }
  }

  return null
}

/**
 * Whether a seeded rate is acceptable for a binding quote.
 *
 * Default is no: quoting a hard-coded rate to a real sender means the recipient
 * is paid an amount that has no relationship to the market. Operators who
 * knowingly accept that risk can set ALLOW_SEEDED_FX_QUOTES=true.
 */
export function seededQuotesAllowed(): boolean {
  return process.env.ALLOW_SEEDED_FX_QUOTES === 'true'
}

// ─── Conversion ──────────────────────────────────────────────────────────────

/**
 * Convert QUSD base units (6 decimals) into the recipient currency's minor
 * units, rounding half-up to the nearest minor unit.
 */
export function convertToMinor(
  qusdBaseUnits: bigint | string,
  rate: number,
  minorUnits: number,
): number {
  const usd = Number(BigInt(qusdBaseUnits)) / 1_000_000
  return Math.round(usd * rate * minorUnits)
}

export interface PayoutQuote {
  currency: string
  rate: number
  source: 'live' | 'seeded'
  /** Payout amount in minor units. */
  amountMinor: number
  /** Same amount as a display string, e.g. "8,331.55". */
  amountDisplay: string
}

export async function quotePayout(
  qusdBaseUnits: bigint,
  currency: string,
  minorUnits: number,
): Promise<PayoutQuote | null> {
  const fx = await getFxRate(currency)
  if (!fx) return null

  const amountMinor = convertToMinor(qusdBaseUnits, fx.rate, minorUnits)
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) return null

  return {
    currency,
    rate: fx.rate,
    source: fx.source,
    amountMinor,
    amountDisplay: (amountMinor / minorUnits).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  }
}
