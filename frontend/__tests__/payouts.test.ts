/**
 * Tests for the payout state machine, corridor gating and provider plumbing —
 * the parts that decide whether money moves, moves twice, or silently doesn't.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  canTransition,
  assertTransition,
  IllegalPayoutTransition,
  nextAttemptDelayMs,
  MAX_PAYOUT_ATTEMPTS,
  WORKABLE_STATUSES,
  IN_FLIGHT_STATUSES,
} from '@/lib/payouts/state'
import { isTerminal, type PayoutStatus } from '@/lib/payouts/types'
import {
  CORRIDORS,
  getCorridorById,
  getCorridorByIndex,
  validateDestination,
  maskDestination,
  resolveProviderId,
  isCorridorOpen,
  isProviderConfigured,
} from '@/lib/corridors'
import { convertToMinor } from '@/lib/fx/rates'
import { razorpayProvider } from '@/lib/payouts/providers/razorpay'

// ─── State machine ───────────────────────────────────────────────────────────

describe('payout state machine', () => {
  it('walks the happy path', () => {
    expect(canTransition('CREATED', 'SUBMITTED')).toBe(true)
    expect(canTransition('SUBMITTED', 'PROCESSING')).toBe(true)
    expect(canTransition('PROCESSING', 'PAID')).toBe(true)
  })

  it('allows a rail that settles instantly to skip PROCESSING', () => {
    expect(canTransition('SUBMITTED', 'PAID')).toBe(true)
  })

  it('lets a retryable failure go back out for another attempt', () => {
    expect(canTransition('SUBMITTED', 'FAILED')).toBe(true)
    expect(canTransition('FAILED', 'SUBMITTED')).toBe(true)
  })

  it('never leaves a terminal state', () => {
    const terminal: PayoutStatus[] = ['PAID', 'REVERSED', 'MANUAL_REVIEW']
    const everything: PayoutStatus[] = [
      'CREATED', 'SUBMITTED', 'PROCESSING', 'PAID', 'FAILED', 'REVERSED', 'MANUAL_REVIEW',
    ]
    for (const from of terminal) {
      for (const to of everything) {
        if (from === to) continue
        expect(canTransition(from, to)).toBe(false)
      }
    }
  })

  it('specifically refuses to un-pay a paid payout', () => {
    // A late or replayed webhook must never walk PAID backwards, because the
    // worker would then re-submit and the recipient could be paid twice.
    expect(canTransition('PAID', 'PROCESSING')).toBe(false)
    expect(canTransition('PAID', 'SUBMITTED')).toBe(false)
    expect(canTransition('PAID', 'FAILED')).toBe(false)
    expect(() => assertTransition('PAID', 'SUBMITTED')).toThrow(IllegalPayoutTransition)
  })

  it('treats re-applying the same status as a no-op rather than an error', () => {
    expect(canTransition('PROCESSING', 'PROCESSING')).toBe(true)
    expect(canTransition('PAID', 'PAID')).toBe(true)
  })

  it('never puts a terminal payout back in the work queue', () => {
    for (const status of WORKABLE_STATUSES) expect(isTerminal(status)).toBe(false)
    for (const status of IN_FLIGHT_STATUSES) expect(isTerminal(status)).toBe(false)
  })
})

describe('retry backoff', () => {
  it('increases with each attempt', () => {
    const delays = Array.from({ length: MAX_PAYOUT_ATTEMPTS }, (_, i) => nextAttemptDelayMs(i))
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1])
    }
  })

  it('always waits at least a minute', () => {
    for (let i = 0; i < 10; i++) expect(nextAttemptDelayMs(i)).toBeGreaterThanOrEqual(60_000)
  })

  it('adds jitter so a provider outage does not produce a synchronised retry', () => {
    const samples = new Set(Array.from({ length: 40 }, () => nextAttemptDelayMs(2)))
    expect(samples.size).toBeGreaterThan(1)
  })

  it('clamps to the last rung rather than overflowing past the ladder', () => {
    expect(nextAttemptDelayMs(99)).toBeLessThanOrEqual(14_400_000 * 1.2 + 1)
  })
})

// ─── Corridors ───────────────────────────────────────────────────────────────

describe('corridor lookup', () => {
  it('maps the on-chain index to the right corridor', () => {
    expect(getCorridorByIndex(1)?.id).toBe('ae-in')
    expect(getCorridorByIndex(5)?.id).toBe('sg-bd')
  })

  it('returns null for index 0, which the contract uses for "unset"', () => {
    expect(getCorridorByIndex(0)).toBeNull()
  })

  it('returns null for an unknown corridor rather than defaulting to India', () => {
    // The old `mapping[index - 1] || 'ae-in'` silently routed unknown corridors
    // to the UPI rail.
    expect(getCorridorByIndex(99)).toBeNull()
    expect(getCorridorById('nope')).toBeNull()
  })

  it('keeps indices unique and 1-based, since they are written on-chain', () => {
    const indices = CORRIDORS.map(c => c.index)
    expect(new Set(indices).size).toBe(indices.length)
    expect(Math.min(...indices)).toBe(1)
  })
})

describe('destination validation', () => {
  const upi = getCorridorById('ae-in')!
  const spei = getCorridorById('us-mx')!

  it('accepts a normal UPI VPA', () => {
    expect(validateDestination(upi, 'ramesh@okhdfcbank').ok).toBe(true)
  })

  it('accepts hyphenated handles the old offramp regex rejected', () => {
    // The claim route used /^[\w.-]+@[\w.-]+$/ while the offramp route used
    // /^[\w.]+@[\w]+$/ — a valid handle could pass validation and then fail
    // at payout time, after the escrow had already been released.
    expect(validateDestination(upi, 'ram-esh.k@okhdfcbank').ok).toBe(true)
  })

  it('rejects a degenerate VPA the old regex accepted', () => {
    expect(validateDestination(upi, 'a@b').ok).toBe(false)
  })

  it('rejects a VPA with no domain', () => {
    expect(validateDestination(upi, 'ramesh@').ok).toBe(false)
    expect(validateDestination(upi, 'ramesh').ok).toBe(false)
  })

  it('lower-cases UPI handles, which PSPs treat case-insensitively', () => {
    expect(validateDestination(upi, 'Ramesh@OkHdfcBank').value).toBe('ramesh@okhdfcbank')
  })

  it('enforces the CLABE length exactly', () => {
    expect(validateDestination(spei, '1'.repeat(18)).ok).toBe(true)
    expect(validateDestination(spei, '1'.repeat(17)).ok).toBe(false)
    expect(validateDestination(spei, '1'.repeat(19)).ok).toBe(false)
  })

  it('rejects an empty destination', () => {
    expect(validateDestination(upi, '   ').ok).toBe(false)
  })
})

describe('destination masking', () => {
  it('never returns the full UPI handle', () => {
    const upi = getCorridorById('ae-in')!
    const masked = maskDestination(upi, 'ramesh@okhdfcbank')
    expect(masked).not.toContain('ramesh')
    expect(masked).toContain('@okhdfcbank')
  })

  it('leaves only the last four digits of a numeric account', () => {
    const spei = getCorridorById('us-mx')!
    const masked = maskDestination(spei, '012345678901234567')
    expect(masked.endsWith('4567')).toBe(true)
    expect(masked).not.toContain('0123456789')
  })
})

// ─── Corridor gating: the silent-stub guard ──────────────────────────────────

describe('corridor gating', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    delete process.env.RAZORPAY_KEY_ID
    delete process.env.RAZORPAY_KEY_SECRET
    delete process.env.RAZORPAY_ACCOUNT_NUMBER
    delete process.env.ENABLE_SANDBOX_PAYOUTS
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  it('closes every corridor when nothing is configured', () => {
    for (const corridor of CORRIDORS) {
      expect(isCorridorOpen(corridor, true)).toBe(false)
    }
  })

  it('opens the UPI corridor only with a LIVE Razorpay key on a production chain', () => {
    const upi = getCorridorById('ae-in')!

    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc123'
    process.env.RAZORPAY_KEY_SECRET = 'secret'
    process.env.RAZORPAY_ACCOUNT_NUMBER = '1234567890'
    // A test key was previously the trigger to fake a successful payout.
    expect(isProviderConfigured('razorpay', true)).toBe(false)
    expect(isCorridorOpen(upi, true)).toBe(false)

    process.env.RAZORPAY_KEY_ID = 'rzp_live_abc123'
    expect(isProviderConfigured('razorpay', true)).toBe(true)
    expect(resolveProviderId(upi, true)).toBe('razorpay')
  })

  it('accepts a test key off a production chain', () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc123'
    process.env.RAZORPAY_KEY_SECRET = 'secret'
    process.env.RAZORPAY_ACCOUNT_NUMBER = '1234567890'
    expect(isProviderConfigured('razorpay', false)).toBe(true)
  })

  it('refuses the sandbox rail on a production chain', () => {
    process.env.ENABLE_SANDBOX_PAYOUTS = 'true'
    expect(isProviderConfigured('sandbox', true)).toBe(false)
    for (const corridor of CORRIDORS) {
      expect(resolveProviderId(corridor, true)).toBeNull()
    }
  })

  it('allows the sandbox rail off a production chain', () => {
    process.env.ENABLE_SANDBOX_PAYOUTS = 'true'
    expect(isProviderConfigured('sandbox', false)).toBe(true)
    expect(resolveProviderId(getCorridorById('sg-bd')!, false)).toBe('sandbox')
  })

  it('leaves corridors with no implemented provider closed even in sandbox mode on mainnet', () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_live_abc'
    process.env.RAZORPAY_KEY_SECRET = 'secret'
    process.env.RAZORPAY_ACCOUNT_NUMBER = '123'
    // SPEI, OPay, JazzCash and bKash have no provider — they must stay shut.
    for (const id of ['us-mx', 'gb-ng', 'sa-pk', 'sg-bd']) {
      expect(isCorridorOpen(getCorridorById(id)!, true)).toBe(false)
    }
    expect(isCorridorOpen(getCorridorById('ae-in')!, true)).toBe(true)
  })
})

// ─── Amount conversion ───────────────────────────────────────────────────────

// The rate below is an arbitrary constant chosen to make the arithmetic easy to
// read. It is NOT a market rate and must never be copied into application code —
// see __tests__/fx.test.ts for why hard-coded rates were removed.
describe('convertToMinor', () => {
  it('converts QUSD base units to paise at the given rate', () => {
    expect(convertToMinor(100_000_000n, 83.45, 100)).toBe(834_500)
  })

  it('converts the NET amount, not the gross', () => {
    // The old code passed the gross on-chain `amount` while escrow only
    // released `amount - fee`, so every payout overpaid by the fee.
    const gross = 100_000_000n
    const fee = (gross * 10n) / 10_000n
    const net = gross - fee

    const grossPaise = convertToMinor(gross, 83.45, 100)
    const netPaise = convertToMinor(net, 83.45, 100)

    expect(netPaise).toBeLessThan(grossPaise)
    // 0.1 QUSD of fee at 83.45 = ₹8.345 = 834 paise overpaid on every ₹8,345.
    expect(grossPaise - netPaise).toBe(834)
  })

  it('rounds to a whole minor unit', () => {
    expect(Number.isInteger(convertToMinor(1_234_567n, 83.4567, 100))).toBe(true)
  })
})

// ─── Webhook signature verification ──────────────────────────────────────────

describe('razorpay webhook verification', () => {
  const SECRET = 'whsec_test_value'
  const saved = { ...process.env }

  beforeEach(() => {
    process.env.RAZORPAY_WEBHOOK_SECRET = SECRET
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  function sign(body: string) {
    return createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')
  }

  const payoutBody = JSON.stringify({
    event: 'payout.processed',
    created_at: 1_700_000_000,
    payload: { payout: { entity: { id: 'pout_abc123', status: 'processed', utr: 'UTR123' } } },
  })

  it('accepts a correctly signed event', () => {
    const headers = new Headers({ 'x-razorpay-signature': sign(payoutBody) })
    const result = razorpayProvider.verifyWebhook(payoutBody, headers)
    expect(result.ok).toBe(true)
    expect(result.providerRef).toBe('pout_abc123')
    expect(result.status).toBe('PAID')
    expect(result.utr).toBe('UTR123')
  })

  it('rejects a forged signature', () => {
    const headers = new Headers({ 'x-razorpay-signature': 'deadbeef'.repeat(8) })
    expect(razorpayProvider.verifyWebhook(payoutBody, headers).ok).toBe(false)
  })

  it('rejects a missing signature', () => {
    expect(razorpayProvider.verifyWebhook(payoutBody, new Headers()).ok).toBe(false)
  })

  it('rejects a tampered body signed with the original digest', () => {
    const signature = sign(payoutBody)
    const tampered = payoutBody.replace('pout_abc123', 'pout_attacker')
    const headers = new Headers({ 'x-razorpay-signature': signature })
    expect(razorpayProvider.verifyWebhook(tampered, headers).ok).toBe(false)
  })

  it('refuses to verify anything when no webhook secret is configured', () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET
    const headers = new Headers({ 'x-razorpay-signature': 'anything' })
    expect(razorpayProvider.verifyWebhook(payoutBody, headers).ok).toBe(false)
  })

  it('maps provider states to ledger states conservatively', () => {
    const cases: Array<[string, string]> = [
      ['processed', 'PAID'],
      ['processing', 'PROCESSING'],
      ['queued', 'PROCESSING'],
      ['pending', 'PROCESSING'],
      ['reversed', 'REVERSED'],
      ['failed', 'FAILED'],
      ['rejected', 'FAILED'],
      ['cancelled', 'FAILED'],
      // An unrecognised state must go to a human, never be guessed at.
      ['some_new_state', 'MANUAL_REVIEW'],
    ]

    for (const [providerStatus, expected] of cases) {
      const body = JSON.stringify({
        event: 'payout.updated',
        payload: { payout: { entity: { id: 'pout_x', status: providerStatus } } },
      })
      const headers = new Headers({ 'x-razorpay-signature': sign(body) })
      expect(razorpayProvider.verifyWebhook(body, headers).status).toBe(expected)
    }
  })

  it('verifies non-payout events without producing a payout update', () => {
    const body = JSON.stringify({ event: 'transaction.created', payload: {} })
    const headers = new Headers({ 'x-razorpay-signature': sign(body) })
    const result = razorpayProvider.verifyWebhook(body, headers)
    expect(result.ok).toBe(true)
    expect(result.providerRef).toBeUndefined()
  })
})
