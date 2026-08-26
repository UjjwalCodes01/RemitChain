/**
 * Tests for the FX layer.
 *
 * The property that matters: when we do not have a rate we can vouch for, we
 * return null so the caller refuses the transfer. We never substitute a
 * default, because a wrong rate pays the wrong amount to a real person and
 * looks like success.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fx from '@/lib/fx/rates'
import { convertToMinor, getFxRate, quotePayout, maxStalenessMs } from '@/lib/fx/rates'

const ER_API = 'https://open.er-api.com/v6/latest/USD'
const CURRENCY_API = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json'

const LIVE_RATES = { INR: 95.43, MXN: 16.95, NGN: 1350.75, PKR: 277.53, BDT: 122.57 }

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
  // Redis is absent in tests, so cacheGet/cacheSet are no-ops and every call
  // exercises the fetch path.
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── No hard-coded rates ─────────────────────────────────────────────────────

describe('the seeded-rate table is gone', () => {
  it('exports no rate constants at all', () => {
    // A committed exchange rate is stale the moment it is written. On
    // 2026-08-26 the old table was off by -73% for PKR and +49% for NGN.
    expect((fx as Record<string, unknown>).SEEDED_RATES).toBeUndefined()
    expect((fx as Record<string, unknown>).seededQuotesAllowed).toBeUndefined()
  })

  it('has no numeric literal that looks like an FX rate in its exports', () => {
    const numericExports = Object.values(fx).filter(v => typeof v === 'number')
    expect(numericExports).toHaveLength(0)
  })
})

// ─── Failure behaviour ───────────────────────────────────────────────────────

describe('getFxRate when sources fail', () => {
  it('returns null rather than a fallback when every source is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const { getFxRate: fresh } = await import('@/lib/fx/rates')
    expect(await fresh('INR')).toBeNull()
  })

  it('returns null when sources respond but with an unusable shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ nonsense: true })))
    const { getFxRate: fresh } = await import('@/lib/fx/rates')
    expect(await fresh('INR')).toBeNull()
  })

  it('returns null for a currency the feed does not carry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJson({ result: 'success', rates: { INR: 95.43 } }),
    ))
    const { getFxRate: fresh } = await import('@/lib/fx/rates')
    expect(await fresh('XYZ')).toBeNull()
  })

  it('returns null for a non-positive rate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJson({ result: 'success', rates: { INR: 0 } }),
    ))
    const { getFxRate: fresh } = await import('@/lib/fx/rates')
    expect(await fresh('INR')).toBeNull()
  })
})

// ─── Redundancy ──────────────────────────────────────────────────────────────

describe('source failover', () => {
  it('uses the primary source when it works', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url === ER_API
        ? okJson({ result: 'success', rates: LIVE_RATES })
        : okJson({ usd: {} }),
    ))
    const { getFxRate: fresh } = await import('@/lib/fx/rates')
    const quote = await fresh('INR')
    expect(quote?.rate).toBe(95.43)
    expect(quote?.provider).toBe('er-api')
  })

  it('falls through to the second source when the primary fails', async () => {
    // A single free API being down must not close every corridor.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === ER_API) throw new Error('502')
      if (url === CURRENCY_API) {
        return okJson({ usd: { inr: 95.27, mxn: 16.95, ngn: 1346.9, pkr: 277.33, bdt: 122.9 } })
      }
      throw new Error('unexpected url')
    }))
    const { getFxRate: fresh } = await import('@/lib/fx/rates')
    const quote = await fresh('INR')
    expect(quote?.provider).toBe('currency-api')
    expect(quote?.rate).toBeCloseTo(95.27, 2)
  })

  it('uppercases currency keys from the lower-cased fallback feed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === ER_API) throw new Error('down')
      return okJson({ usd: { pkr: 277.33 } })
    }))
    const { getFxRate: fresh } = await import('@/lib/fx/rates')
    expect((await fresh('PKR'))?.rate).toBeCloseTo(277.33, 2)
  })
})

// ─── Staleness ───────────────────────────────────────────────────────────────

describe('staleness bound', () => {
  it('defaults to 60 minutes', async () => {
    const { maxStalenessMs: fresh } = await import('@/lib/fx/rates')
    expect(fresh()).toBe(60 * 60 * 1000)
  })

  it('is configurable', async () => {
    vi.stubEnv('FX_MAX_STALENESS_MINUTES', '15')
    const { maxStalenessMs: fresh } = await import('@/lib/fx/rates')
    expect(fresh()).toBe(15 * 60 * 1000)
  })

  it('ignores a nonsensical configured value and keeps the default', async () => {
    vi.stubEnv('FX_MAX_STALENESS_MINUTES', 'not-a-number')
    const { maxStalenessMs: fresh } = await import('@/lib/fx/rates')
    expect(fresh()).toBe(60 * 60 * 1000)
  })
})

// ─── Quoting ─────────────────────────────────────────────────────────────────

describe('quotePayout', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJson({ result: 'success', rates: LIVE_RATES }),
    ))
  })

  it('converts the net amount at the live rate', async () => {
    const { quotePayout: fresh } = await import('@/lib/fx/rates')
    // 99.9 QUSD (100 minus the 0.1% fee) at 95.43 → ₹9,533.46 → 953346 paise
    const quote = await fresh(99_900_000n, 'INR', 100)
    expect(quote?.amountMinor).toBe(953_346)
    expect(quote?.currency).toBe('INR')
  })

  it('returns null when no rate is available, so the send is refused', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    const { quotePayout: fresh } = await import('@/lib/fx/rates')
    expect(await fresh(99_900_000n, 'INR', 100)).toBeNull()
  })

  it('returns null for an amount that rounds to zero minor units', async () => {
    const { quotePayout: fresh } = await import('@/lib/fx/rates')
    expect(await fresh(0n, 'INR', 100)).toBeNull()
  })
})

// ─── Conversion arithmetic ───────────────────────────────────────────────────

describe('convertToMinor', () => {
  it('converts QUSD base units to minor units at a given rate', () => {
    expect(convertToMinor(100_000_000n, 95.43, 100)).toBe(954_300)
  })

  it('shows what the old seeded PKR rate would have cost a recipient', () => {
    // 100 QUSD to Pakistan. Seeded 75.20 vs live 277.53.
    const seeded = convertToMinor(100_000_000n, 75.2, 100)
    const live = convertToMinor(100_000_000n, 277.53, 100)
    expect(seeded).toBe(752_000)      // ₨7,520
    expect(live).toBe(2_775_300)      // ₨27,753
    // The recipient would have received 27% of what they were owed.
    expect(seeded / live).toBeLessThan(0.28)
  })

  it('shows what the old seeded NGN rate would have cost the treasury', () => {
    const seeded = convertToMinor(100_000_000n, 2018, 100)
    const live = convertToMinor(100_000_000n, 1350.75, 100)
    // Overpaying by ~49% on every Nigeria payout.
    expect(seeded / live).toBeGreaterThan(1.49)
  })

  it('always returns a whole number of minor units', () => {
    expect(Number.isInteger(convertToMinor(1_234_567n, 95.4321, 100))).toBe(true)
  })

  it('handles a zero-decimal currency', () => {
    expect(convertToMinor(100_000_000n, 150.0, 1)).toBe(15_000)
  })
})
