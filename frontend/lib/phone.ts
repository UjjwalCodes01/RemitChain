/**
 * lib/phone.ts
 *
 * Phone number normalisation and the on-chain phone commitment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE SALT CHANGED
 * ─────────────────────────────────────────────────────────────────────────────
 * The previous build hashed phone numbers with a hard-coded public constant:
 *
 *     phoneHash = keccak256(abi.encodePacked(bytes32(0xDEADBEEF), phone))
 *
 * That value is in the source, in the test helpers and in the deployed
 * frontend bundle, and `recipientPhoneHash` is readable on-chain for every
 * transfer. A national phone space is ~10^10 candidates, so the recipient's
 * actual number was recoverable by anyone with a GPU — a privacy breach on its
 * own, and one half of the credentials the claim API checks.
 *
 * It is now keyed with PHONE_HASH_PEPPER, a server-side secret. The hash is
 * computed only on the server: the browser never sees the pepper, and the send
 * page no longer computes the commitment at all.
 *
 * The pepper is permanent. Rotating it invalidates every pending transfer's
 * phone commitment, so it must be treated like a database encryption key.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BACKWARD COMPATIBILITY
 * ─────────────────────────────────────────────────────────────────────────────
 * `phoneHashCandidates` returns the peppered hash first and, while
 * ALLOW_LEGACY_OTP_SCHEME is set, the legacy 0xDEADBEEF hash second, so
 * transfers created before the cutover remain claimable until they expire.
 */

import { keccak256, encodeAbiParameters, encodePacked, toHex, type Hex } from 'viem'
/**
 * `core` + an explicitly imported metadata document, rather than the
 * convenience `libphonenumber-js/max` entry point.
 *
 * Two reasons:
 *
 *  1. `max` metadata, not the default `min` bundle. The min bundle cannot
 *     distinguish number TYPES and validates loosely, so it accepts strings
 *     that are not real allocated ranges. Larger, and only ever loaded on the
 *     server — the right trade when the alternative is quoting a transfer to a
 *     number that cannot receive anything.
 *
 *  2. The `max` entry point resolves its metadata through an internal JSON
 *     require, which does not survive every toolchain: under `tsx` it silently
 *     yields `undefined` and the first parse throws
 *     `Cannot read properties of undefined (reading 'hasOwnProperty')`. That
 *     made `lib/phone.ts` unusable from any `scripts/` entry. Passing the
 *     metadata explicitly removes the dependency on how a given runtime
 *     resolves JSON.
 */
import { isLegacySchemeAllowed } from '@/lib/claim-secret'
import { parsePhoneNumberFromString as parseWithMetadata, type CountryCode } from 'libphonenumber-js/core'
import metadata from 'libphonenumber-js/metadata.max.json'

function parsePhoneNumberFromString(input: string, country?: CountryCode) {
  // The core signature requires the options argument, so pass an object rather
  // than an undefined country.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return parseWithMetadata(input, { defaultCountry: country }, metadata as any)
}

// ─── Normalisation ───────────────────────────────────────────────────────────

export interface PhoneParseResult {
  ok: boolean
  /** Canonical E.164, e.g. "+919876543210". Only set when ok. */
  e164: string
  /** Human display form, e.g. "+91 98765 43210". */
  formatted: string
  error?: string
}

/**
 * Parse a user-entered phone number into canonical E.164.
 *
 * `defaultCountry` comes from the corridor's receiving country, so a recipient
 * in India can type "09876543210" or "98765 43210" and still resolve correctly.
 * The old implementation did this with hand-rolled string surgery
 * (`digits.length > 10 ? '+' + digits : dialCode + digits`) which silently
 * produced wrong numbers for national formats with a trunk prefix.
 */
export function parsePhone(raw: string, defaultCountry?: string): PhoneParseResult {
  const input = (raw ?? '').trim()
  if (!input) return { ok: false, e164: '', formatted: '', error: 'Phone number is required' }

  const parsed = parsePhoneNumberFromString(input, defaultCountry as CountryCode | undefined)

  if (!parsed || !parsed.isValid()) {
    return {
      ok: false,
      e164: '',
      formatted: input,
      error: 'Enter a valid mobile number, including the country code.',
    }
  }

  // The recipient has to be reachable. A landline cannot receive the claim SMS,
  // and a premium-rate or shared-cost line should never be a payout contact.
  const type = parsed.getType()
  if (type && !['MOBILE', 'FIXED_LINE_OR_MOBILE'].includes(type)) {
    return {
      ok: false,
      e164: '',
      formatted: input,
      error: 'Enter a mobile number — this number cannot receive a claim code.',
    }
  }

  return { ok: true, e164: parsed.number, formatted: parsed.formatInternational() }
}

/** Is this already a canonical E.164 string? */
export const E164_PATTERN = /^\+[1-9]\d{6,14}$/

/**
 * Mask for logs, support tooling and API responses.
 * "+919876543210" → "+91•••••3210"
 */
export function maskPhone(e164: string): string {
  if (!e164 || e164.length < 7) return '•••'
  const cc = e164.slice(0, 3)
  const tail = e164.slice(-4)
  return `${cc}${'•'.repeat(Math.max(3, e164.length - 7))}${tail}`
}

// ─── Commitment (server only) ────────────────────────────────────────────────

const LEGACY_SALT = toHex(BigInt('0xDEADBEEF'), { size: 32 }) as Hex

let _pepper: Hex | null = null

function getPepper(): Hex {
  if (_pepper) return _pepper

  const raw = process.env.PHONE_HASH_PEPPER
  if (!raw) {
    throw new Error(
      'PHONE_HASH_PEPPER is not set. Generate one with:\n' +
      "  node -e \"console.log('0x' + require('crypto').randomBytes(32).toString('hex'))\"\n" +
      'This value is permanent — rotating it invalidates every pending transfer.',
    )
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(raw)) {
    throw new Error('PHONE_HASH_PEPPER must be a 32-byte hex string with an 0x prefix.')
  }

  _pepper = raw as Hex
  return _pepper
}

export function isPhonePepperConfigured(): boolean {
  try {
    getPepper()
    return true
  } catch {
    return false
  }
}

/** The commitment written on-chain: keccak256(abi.encode(pepper, e164)). */
export function computePhoneHash(e164: string): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'string' }], [getPepper(), e164]),
  )
}

/** The pre-upgrade commitment. Verification only — never write these again. */
export function computeLegacyPhoneHash(e164: string): Hex {
  return keccak256(encodePacked(['bytes32', 'string'], [LEGACY_SALT, e164]))
}

/**
 * Every hash a given phone number could legitimately match, newest scheme
 * first. The claim route compares the on-chain value against each in turn so
 * transfers created before the pepper cutover still verify.
 */
export function phoneHashCandidates(e164: string): Hex[] {
  const candidates: Hex[] = [computePhoneHash(e164)]
  // Shares the cutover window with the OTP scheme, including its expiry — see
  // lib/claim-secret.ts. Reading the raw env var here would have let the phone
  // fallback outlive the OTP one.
  if (isLegacySchemeAllowed()) {
    candidates.push(computeLegacyPhoneHash(e164))
  }
  return candidates
}

/** Constant-time-ish comparison across the candidate set. */
export function phoneHashMatches(e164: string, onChainHash: string): boolean {
  const target = onChainHash.toLowerCase()
  // Evaluate every candidate — do not short-circuit, so the timing profile does
  // not reveal which scheme matched.
  let matched = false
  for (const candidate of phoneHashCandidates(e164)) {
    if (candidate.toLowerCase() === target) matched = true
  }
  return matched
}
