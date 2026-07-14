/**
 * lib/fx/rates.ts
 *
 * Lightweight FX rate fetcher with a 5-minute in-memory cache.
 *
 * Primary source: open.er-api.com (free, no API key required).
 * Fallback: hardcoded seeded rates (same values shown in the send page UI).
 *
 * Usage:
 *   const usdToInr = await getFxRate('INR')  // → 83.45 ish
 */

// ── Seeded fallback rates (USD base) ─────────────────────────────────────────
// Keep in sync with CORRIDORS in app/send/page.tsx
export const SEEDED_RATES: Record<string, number> = {
  INR: 83.45,  // ae-in (UAE → India)
  MXN: 17.12,  // us-mx (USA → Mexico)
  NGN: 2018.0, // gb-ng (UK → Nigeria)
  PKR: 75.2,   // sa-pk (Saudi → Pakistan)
  BDT: 82.4,   // sg-bd (Singapore → Bangladesh)
}

// ── Corridor → currency mapping ───────────────────────────────────────────────
export const CORRIDOR_CURRENCY: Record<number, string> = {
  1: 'INR',
  2: 'MXN',
  3: 'NGN',
  4: 'PKR',
  5: 'BDT',
}

// ── In-memory cache ───────────────────────────────────────────────────────────
interface CacheEntry { rates: Record<string, number>; fetchedAt: number }
let _cache: CacheEntry | null = null
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ── Fetcher ───────────────────────────────────────────────────────────────────
async function fetchRates(): Promise<Record<string, number>> {
  const res = await fetch('https://open.er-api.com/v6/latest/USD', {
    next: { revalidate: 300 }, // Next.js fetch cache: 5 min
  })
  if (!res.ok) throw new Error(`FX API responded ${res.status}`)
  const data = (await res.json()) as { result: string; rates: Record<string, number> }
  if (data.result !== 'success') throw new Error('FX API returned non-success result')
  return data.rates
}

/**
 * Returns the live USD → targetCurrency exchange rate.
 * Falls back to the seeded rate if the fetch fails or times out.
 */
export async function getFxRate(currency: string): Promise<number> {
  const now = Date.now()

  // Return cached rates if fresh
  if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.rates[currency] ?? SEEDED_RATES[currency] ?? 1
  }

  try {
    const rates = await fetchRates()
    _cache = { rates, fetchedAt: now }
    return rates[currency] ?? SEEDED_RATES[currency] ?? 1
  } catch (err) {
    console.warn('[FX] Rate fetch failed, using seeded fallback:', err)
    return SEEDED_RATES[currency] ?? 1
  }
}

/**
 * Convert a QUSD amount (6 decimals, stored as bigint string) to the
 * local currency amount in the smallest unit (paise, centavos, kobo, etc.).
 *
 * @param rawAmount   bigint string from on-chain (6 decimal QUSD)
 * @param currency    ISO 4217 currency code e.g. 'INR'
 * @param subunitMult multiplier to smallest unit (100 for INR paise, 100 for MXN centavos, etc.)
 */
export async function qusdToLocalSubunit(
  rawAmount: bigint | string,
  currency: string,
  subunitMult = 100,
): Promise<number> {
  const usdValue = Number(BigInt(rawAmount)) / 1_000_000 // QUSD has 6 decimals
  const rate = await getFxRate(currency)
  return Math.round(usdValue * rate * subunitMult)
}
