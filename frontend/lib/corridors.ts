/**
 * lib/corridors.ts
 *
 * SINGLE SOURCE OF TRUTH for payout corridors.
 *
 * Previously this table was duplicated in five places (send page, claim page,
 * claim API, offramp routes, fx/rates) and they had already drifted apart —
 * the UPI validator differed between the claim route and the offramp route.
 * Everything now derives from this file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAUNCH SAFETY RULE
 * ─────────────────────────────────────────────────────────────────────────────
 * A corridor is only OPEN for sending when a payout provider is actually wired
 * up AND its credentials are present in the environment. A corridor with no
 * live provider is CLOSED: the send page will not offer it and the API will
 * reject it.
 *
 * This is deliberate. The previous build reported `offrampStatus: 'COMPLETED'`
 * for four of five corridors while sending no money at all. Silently stubbing a
 * payout is the single most dangerous failure mode a remittance product can
 * have, so it is now structurally impossible: `resolveProviderId()` returns
 * `null` when a corridor has no configured provider, and a null provider means
 * the corridor never opens.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Providers we have a real, money-moving implementation for. */
export type ProviderId = 'razorpay' | 'sandbox'

export interface Corridor {
  /** Stable string id persisted in the DB. Never renumber. */
  readonly id: CorridorId
  /** On-chain `corridor` field (uint8). 1-indexed. Never renumber — it is on-chain. */
  readonly index: number
  readonly sendCountry: string
  readonly recvCountry: string
  readonly label: string
  readonly flags: string
  /** Local payout rail shown to the recipient. */
  readonly rail: string
  /** ISO-4217 code of the currency the recipient is paid in. */
  readonly currency: string
  readonly currencySymbol: string
  /** Minor units per major unit (100 = paise/centavos/kobo; 1 = zero-decimal). */
  readonly minorUnits: number
  /** Human label for the destination field, e.g. "UPI ID / VPA". */
  readonly destinationLabel: string
  readonly destinationPlaceholder: string
  readonly destinationHint: string
  /** Canonical validator for the payout destination. The ONLY definition. */
  readonly destinationPattern: RegExp
  /** Providers that can service this corridor, in priority order. */
  readonly providers: readonly ProviderId[]
}

export type CorridorId = 'ae-in' | 'us-mx' | 'gb-ng' | 'sa-pk' | 'sg-bd'

// ─── The table ───────────────────────────────────────────────────────────────

export const CORRIDORS: readonly Corridor[] = [
  {
    id: 'ae-in',
    index: 1,
    sendCountry: 'AE',
    recvCountry: 'IN',
    label: 'UAE → India',
    flags: '🇦🇪 → 🇮🇳',
    rail: 'UPI',
    currency: 'INR',
    currencySymbol: '₹',
    minorUnits: 100,
    destinationLabel: 'UPI ID / VPA',
    destinationPlaceholder: 'name@bank',
    destinationHint: 'Funds are deposited to the bank account linked to this UPI address.',
    // Canonical UPI VPA shape. Deliberately stricter than the old
    // /^[\w.-]+@[\w.-]+$/ (which accepted a bare "a@b") and looser than the old
    // offramp route's /^[\w.]+@[\w]+$/ (which rejected legitimate hyphenated handles).
    destinationPattern: /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/,
    providers: ['razorpay'],
  },
  {
    id: 'us-mx',
    index: 2,
    sendCountry: 'US',
    recvCountry: 'MX',
    label: 'USA → Mexico',
    flags: '🇺🇸 → 🇲🇽',
    rail: 'SPEI',
    currency: 'MXN',
    currencySymbol: 'MX$',
    minorUnits: 100,
    destinationLabel: 'SPEI CLABE',
    destinationPlaceholder: '18-digit CLABE',
    destinationHint: '18-digit Mexican interbank CLABE account number.',
    destinationPattern: /^\d{18}$/,
    providers: [],
  },
  {
    id: 'gb-ng',
    index: 3,
    sendCountry: 'GB',
    recvCountry: 'NG',
    label: 'UK → Nigeria',
    flags: '🇬🇧 → 🇳🇬',
    rail: 'OPay',
    currency: 'NGN',
    currencySymbol: '₦',
    minorUnits: 100,
    destinationLabel: 'OPay Account',
    destinationPlaceholder: '10-digit account number',
    destinationHint: '10-digit Nigerian mobile wallet number.',
    destinationPattern: /^\d{10}$/,
    providers: [],
  },
  {
    id: 'sa-pk',
    index: 4,
    sendCountry: 'SA',
    recvCountry: 'PK',
    label: 'Saudi Arabia → Pakistan',
    flags: '🇸🇦 → 🇵🇰',
    rail: 'JazzCash',
    currency: 'PKR',
    currencySymbol: '₨',
    minorUnits: 100,
    destinationLabel: 'JazzCash Account',
    destinationPlaceholder: '11-digit account number',
    destinationHint: '11-digit Pakistani mobile money account number.',
    destinationPattern: /^\d{11}$/,
    providers: [],
  },
  {
    id: 'sg-bd',
    index: 5,
    sendCountry: 'SG',
    recvCountry: 'BD',
    label: 'Singapore → Bangladesh',
    flags: '🇸🇬 → 🇧🇩',
    rail: 'bKash',
    currency: 'BDT',
    currencySymbol: '৳',
    minorUnits: 100,
    destinationLabel: 'bKash Account',
    destinationPlaceholder: '11-digit wallet number',
    destinationHint: '11-digit Bangladesh bKash wallet number.',
    destinationPattern: /^\d{11}$/,
    providers: [],
  },
] as const

// ─── Lookups ─────────────────────────────────────────────────────────────────

const BY_ID = new Map<string, Corridor>(CORRIDORS.map(c => [c.id, c]))
const BY_INDEX = new Map<number, Corridor>(CORRIDORS.map(c => [c.index, c]))

export function getCorridorById(id: string | null | undefined): Corridor | null {
  if (!id) return null
  return BY_ID.get(id) ?? null
}

/** Look up by the on-chain uint8. Returns null for 0 or any unknown index. */
export function getCorridorByIndex(index: number | null | undefined): Corridor | null {
  if (index === null || index === undefined) return null
  return BY_INDEX.get(Number(index)) ?? null
}

// ─── Provider resolution & corridor enablement ───────────────────────────────

/**
 * Is this provider actually usable right now?
 *
 * `sandbox` is only usable on a non-production chain. It exists so the full
 * pipeline — ledger, state machine, webhooks, reconciliation — can be exercised
 * end to end on testnet without a provider account. It can never be selected on
 * a production chain: `assertPayoutConfigSafe()` refuses to boot in that case.
 */
export function isProviderConfigured(provider: ProviderId, isProductionChain: boolean): boolean {
  switch (provider) {
    case 'razorpay':
      return Boolean(
        process.env.RAZORPAY_KEY_ID &&
        process.env.RAZORPAY_KEY_SECRET &&
        process.env.RAZORPAY_ACCOUNT_NUMBER &&
        // A `rzp_test_*` key is a sandbox key. It is fine on testnet, never on a
        // production chain — the old build treated it as a signal to fake a
        // successful payout, which is exactly the behaviour we are removing.
        (!isProductionChain || process.env.RAZORPAY_KEY_ID.startsWith('rzp_live_')),
      )
    case 'sandbox':
      return !isProductionChain && process.env.ENABLE_SANDBOX_PAYOUTS === 'true'
    default:
      return false
  }
}

/** First configured provider for a corridor, or null when the corridor is closed. */
export function resolveProviderId(corridor: Corridor, isProductionChain: boolean): ProviderId | null {
  for (const p of corridor.providers) {
    if (isProviderConfigured(p, isProductionChain)) return p
  }
  // Sandbox is a universal fallback, but only ever off a production chain.
  if (isProviderConfigured('sandbox', isProductionChain)) return 'sandbox'
  return null
}

export function isCorridorOpen(corridor: Corridor, isProductionChain: boolean): boolean {
  return resolveProviderId(corridor, isProductionChain) !== null
}

/** Corridors a sender may actually choose right now. */
export function getOpenCorridors(isProductionChain: boolean): Corridor[] {
  return CORRIDORS.filter(c => isCorridorOpen(c, isProductionChain))
}

// ─── Destination validation ──────────────────────────────────────────────────

export interface DestinationValidation {
  ok: boolean
  /** Trimmed, normalised value to persist and send to the provider. */
  value: string
  error?: string
}

export function validateDestination(corridor: Corridor, raw: string): DestinationValidation {
  const value = raw.trim()
  if (!value) {
    return { ok: false, value, error: `${corridor.destinationLabel} is required` }
  }
  // UPI VPAs are case-insensitive and conventionally lower-cased by PSPs.
  const normalised = corridor.rail === 'UPI' ? value.toLowerCase() : value
  if (!corridor.destinationPattern.test(normalised)) {
    return { ok: false, value: normalised, error: `Invalid ${corridor.destinationLabel}. ${corridor.destinationHint}` }
  }
  return { ok: true, value: normalised }
}

/**
 * Mask a payout destination for logs, support tooling and API responses.
 * Never log or return a full account identifier.
 */
export function maskDestination(corridor: Corridor, value: string): string {
  if (corridor.rail === 'UPI') {
    const [handle, domain] = value.split('@')
    if (!domain) return '•••'
    const head = handle.slice(0, 2)
    return `${head}${'•'.repeat(Math.max(2, handle.length - 2))}@${domain}`
  }
  if (value.length <= 4) return '•'.repeat(value.length)
  return `${'•'.repeat(value.length - 4)}${value.slice(-4)}`
}
