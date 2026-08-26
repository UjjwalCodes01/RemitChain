/**
 * lib/fx/rates.ts
 *
 * Exchange rates for payout conversion.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THERE ARE NO HARD-CODED RATES IN THIS FILE, DELIBERATELY
 * ─────────────────────────────────────────────────────────────────────────────
 * The previous version carried a `SEEDED_RATES` table that `getFxRate` silently
 * fell back to. Checked against the live market on 2026-08-26, every entry was
 * wrong, and wrong in both directions:
 *
 *     PKR   75.20  vs  277.53 live  — recipient receives 27% of what they are owed
 *     BDT   82.40  vs  122.57 live  — recipient receives 67%
 *     INR   83.45  vs   95.43 live  — recipient receives 87%
 *     NGN 2018.00  vs 1350.75 live  — treasury overpays by 49%
 *     MXN   17.12  vs   16.95 live  — roughly correct, by luck
 *
 * A committed exchange rate is stale the moment it is written, and nothing in
 * the system can tell you it has gone stale. A remittance that pays out a
 * quarter of what was promised is worse than one that fails, because it looks
 * like it worked.
 *
 * So the rule here is: a rate is either sourced live (or from a cache with a
 * bounded age), or there is no rate and we refuse to quote. `getFxRate` returns
 * null rather than guessing, `/api/corridors` reports the corridor as closed,
 * and `/api/transfers/prepare` returns 503. Refusing a send is recoverable;
 * paying the wrong amount is not.
 */

import { cacheGet, cacheSet } from '@/lib/db/redis'

export interface FxQuote {
  currency: string
  rate: number
  /** 'live' = fetched this request. 'cached' = within the staleness bound. */
  source: 'live' | 'cached'
  fetchedAt: number
  /** Which upstream produced it, for support and audit. */
  provider: string
  ageMs: number
}

// ─── Sources ─────────────────────────────────────────────────────────────────
// Two independent upstreams so a single provider outage does not close every
// corridor. Both are free and keyless; both cover the full corridor set.

interface RateSource {
  name: string
  url: string
  parse: (body: unknown) => Record<string, number> | null
}

const SOURCES: RateSource[] = [
  {
    name: 'er-api',
    url: 'https://open.er-api.com/v6/latest/USD',
    parse: body => {
      const d = body as { result?: string; rates?: Record<string, number> }
      if (d.result !== 'success' || !d.rates) return null
      return d.rates
    },
  },
  {
    name: 'currency-api',
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    parse: body => {
      const d = body as { usd?: Record<string, number> }
      if (!d.usd) return null
      // This source keys currencies in lower case.
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(d.usd)) {
        if (typeof v === 'number') out[k.toUpperCase()] = v
      }
      return out
    },
  },
]

// ─── Cache & staleness ───────────────────────────────────────────────────────

const CACHE_KEY = 'fx:usd:v3'
/** Refresh after this long. */
const SOFT_TTL_MS = 5 * 60 * 1000
/** Absolute ceiling on the age of a rate backing a binding quote. */
const DEFAULT_MAX_STALENESS_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 6_000

/**
 * How old a cached rate may be and still be used to quote a transfer.
 * Beyond this we refuse rather than quote on data we cannot vouch for.
 */
export function maxStalenessMs(): number {
  const configured = Number(process.env.FX_MAX_STALENESS_MINUTES)
  if (Number.isFinite(configured) && configured > 0) return configured * 60 * 1000
  return DEFAULT_MAX_STALENESS_MS
}

interface CachedRates {
  rates: Record<string, number>
  fetchedAt: number
  provider: string
}

/** Process-local memo so repeated calls in one request skip Redis. */
let _local: CachedRates | null = null

// ─── Fetching ────────────────────────────────────────────────────────────────

async function fetchFrom(source: RateSource): Promise<Record<string, number> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(source.url, { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const parsed = source.parse(await res.json())
    if (!parsed) throw new Error('unexpected response shape')
    return parsed
  } catch (err) {
    console.warn(`[fx] source ${source.name} failed: ${String(err).slice(0, 160)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Reject a feed that disagrees wildly with the last known good rates.
 *
 * A provider returning a wrong base currency, a units-vs-hundredths mix-up, or
 * a partially-populated response would otherwise be accepted and used to pay
 * real people. Currencies genuinely move a few percent a day; a 25% jump across
 * the board is a broken feed, not a market event.
 */
function passesSanityCheck(fresh: Record<string, number>, previous: CachedRates | null): boolean {
  if (!previous) return true

  const checks: number[] = []
  for (const [ccy, prevRate] of Object.entries(previous.rates)) {
    const next = fresh[ccy]
    if (typeof next !== 'number' || next <= 0 || prevRate <= 0) continue
    checks.push(Math.abs(next - prevRate) / prevRate)
  }

  if (checks.length < 5) return true // too little overlap to judge

  const median = checks.sort((a, b) => a - b)[Math.floor(checks.length / 2)]
  if (median > 0.25) {
    console.error(
      `[fx] rejecting feed: median move of ${(median * 100).toFixed(1)}% against the last known rates`,
    )
    return false
  }
  return true
}

async function loadRates(): Promise<CachedRates | null> {
  const now = Date.now()

  if (_local && now - _local.fetchedAt < SOFT_TTL_MS) return _local

  const cached = await cacheGet<CachedRates>(CACHE_KEY)
  if (cached && now - cached.fetchedAt < SOFT_TTL_MS) {
    _local = cached
    return cached
  }

  // Cache is stale or absent — try each upstream in order.
  for (const source of SOURCES) {
    const rates = await fetchFrom(source)
    if (!rates) continue
    if (!passesSanityCheck(rates, cached ?? _local)) continue

    const fresh: CachedRates = { rates, fetchedAt: now, provider: source.name }
    _local = fresh
    // Hold it well past the soft TTL so a later outage can still serve from
    // cache, up to the staleness ceiling enforced in getFxRate.
    await cacheSet(CACHE_KEY, fresh, Math.ceil(maxStalenessMs() / 1000) * 2)
    return fresh
  }

  // Every upstream failed. Fall back to whatever we last had; getFxRate decides
  // whether it is still fresh enough to use.
  console.error('[fx] all rate sources failed')
  return cached ?? _local
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Current USD → `currency` rate.
 *
 * Returns null when there is no rate within the staleness bound. Callers MUST
 * treat null as "cannot quote" and refuse the operation — never as zero, and
 * never as a reason to substitute a default.
 */
export async function getFxRate(currency: string): Promise<FxQuote | null> {
  const loaded = await loadRates()
  if (!loaded) return null

  const rate = loaded.rates[currency]
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    console.error(`[fx] no usable rate for ${currency} from ${loaded.provider}`)
    return null
  }

  const ageMs = Date.now() - loaded.fetchedAt
  if (ageMs > maxStalenessMs()) {
    console.error(
      `[fx] rate for ${currency} is ${Math.round(ageMs / 60000)}m old, ` +
      `beyond the ${Math.round(maxStalenessMs() / 60000)}m ceiling — refusing to quote`,
    )
    return null
  }

  return {
    currency,
    rate,
    source: ageMs < SOFT_TTL_MS ? 'live' : 'cached',
    fetchedAt: loaded.fetchedAt,
    provider: loaded.provider,
    ageMs,
  }
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
  source: 'live' | 'cached'
  provider: string
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
    provider: fx.provider,
    amountMinor,
    amountDisplay: (amountMinor / minorUnits).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  }
}
