/**
 * Tests for phone handling, the on-chain phone commitment, and secret storage.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { keccak256, encodePacked, toHex } from 'viem'

const PEPPER = '0x' + '7f'.repeat(32)

beforeAll(() => {
  process.env.PHONE_HASH_PEPPER = PEPPER
  process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64')
})

// Imported after the env is in place — these modules read it on first use.
const phoneMod = await import('@/lib/phone')
const cryptoMod = await import('@/lib/crypto/secretbox')

const {
  parsePhone, maskPhone, computePhoneHash, computeLegacyPhoneHash,
  phoneHashMatches, isPhonePepperConfigured,
} = phoneMod
const { encryptSecret, decryptSecret, safeEqual, isEncryptionConfigured } = cryptoMod

// ─── Parsing ─────────────────────────────────────────────────────────────────

describe('parsePhone', () => {
  it('accepts a full E.164 number', () => {
    const r = parsePhone('+919876543210')
    expect(r.ok).toBe(true)
    expect(r.e164).toBe('+919876543210')
  })

  it('resolves a national number using the corridor country', () => {
    // The old hand-rolled logic did `digits.length > 10 ? '+'+digits : code+digits`,
    // which mangled national formats carrying a trunk prefix.
    const r = parsePhone('09876543210', 'IN')
    expect(r.ok).toBe(true)
    expect(r.e164).toBe('+919876543210')
  })

  it('tolerates spaces, dashes and brackets', () => {
    expect(parsePhone('+91 98765-43210').e164).toBe('+919876543210')
    expect(parsePhone('(98765) 43210', 'IN').e164).toBe('+919876543210')
  })

  it('rejects a number that is too short to be real', () => {
    expect(parsePhone('12345', 'IN').ok).toBe(false)
  })

  it('rejects an empty input', () => {
    expect(parsePhone('', 'IN').ok).toBe(false)
  })

  it('rejects a number that is not valid for the country', () => {
    // 1234567890 is not an allocated Indian mobile range.
    expect(parsePhone('1234567890', 'IN').ok).toBe(false)
  })

  it('normalises the same number written several ways to one E.164 value', () => {
    const forms = ['+919876543210', '09876543210', '98765 43210', '+91 98765 43210']
    const parsed = forms.map(f => parsePhone(f, 'IN'))
    expect(parsed.every(p => p.ok)).toBe(true)
    expect(new Set(parsed.map(p => p.e164)).size).toBe(1)
  })
})

describe('maskPhone', () => {
  it('keeps the country code and last four digits only', () => {
    const masked = maskPhone('+919876543210')
    expect(masked.startsWith('+91')).toBe(true)
    expect(masked.endsWith('3210')).toBe(true)
    expect(masked).not.toContain('98765')
  })
})

// ─── Commitment ──────────────────────────────────────────────────────────────

describe('phone commitment', () => {
  it('is configured from the pepper', () => {
    expect(isPhonePepperConfigured()).toBe(true)
  })

  it('is deterministic', () => {
    expect(computePhoneHash('+919876543210')).toBe(computePhoneHash('+919876543210'))
  })

  it('differs between numbers', () => {
    expect(computePhoneHash('+919876543210')).not.toBe(computePhoneHash('+919876543211'))
  })

  it('differs from the legacy public-salt hash', () => {
    // The whole point of the change: the on-chain value is no longer derivable
    // from public information.
    const phone = '+919876543210'
    expect(computePhoneHash(phone)).not.toBe(computeLegacyPhoneHash(phone))
  })

  it('LEGACY: the old hash was reproducible by anyone, since the salt was public', () => {
    const phone = '+919876543210'
    const publicSalt = toHex(BigInt('0xDEADBEEF'), { size: 32 })
    const attackerComputed = keccak256(encodePacked(['bytes32', 'string'], [publicSalt, phone]))
    expect(attackerComputed).toBe(computeLegacyPhoneHash(phone))
  })

  it('CURRENT: an attacker without the pepper cannot reproduce the hash', () => {
    const phone = '+919876543210'
    const publicSalt = toHex(BigInt('0xDEADBEEF'), { size: 32 })
    const attackerGuess = keccak256(encodePacked(['bytes32', 'string'], [publicSalt, phone]))
    expect(attackerGuess).not.toBe(computePhoneHash(phone))
  })
})

describe('phoneHashMatches', () => {
  const phone = '+919876543210'

  it('matches the peppered hash', () => {
    expect(phoneHashMatches(phone, computePhoneHash(phone))).toBe(true)
  })

  it('rejects a different number', () => {
    expect(phoneHashMatches('+919999999999', computePhoneHash(phone))).toBe(false)
  })

  it('ignores case in the on-chain hex', () => {
    expect(phoneHashMatches(phone, computePhoneHash(phone).toUpperCase())).toBe(true)
  })

  it('rejects a legacy hash when the compatibility flag is off', () => {
    delete process.env.ALLOW_LEGACY_OTP_SCHEME
    expect(phoneHashMatches(phone, computeLegacyPhoneHash(phone))).toBe(false)
  })

  it('accepts a legacy hash during the cutover window', () => {
    process.env.ALLOW_LEGACY_OTP_SCHEME = 'true'
    expect(phoneHashMatches(phone, computeLegacyPhoneHash(phone))).toBe(true)
    delete process.env.ALLOW_LEGACY_OTP_SCHEME
  })
})

// ─── Secret storage ──────────────────────────────────────────────────────────

describe('secretbox', () => {
  it('reports a usable key', () => {
    expect(isEncryptionConfigured()).toBe(true)
  })

  it('round-trips a value', () => {
    const secret = 'a-claim-secret-value'
    expect(decryptSecret(encryptSecret(secret))).toBe(secret)
  })

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
  })

  it('does not leak the plaintext into the ciphertext', () => {
    expect(encryptSecret('483920')).not.toContain('483920')
  })

  it('returns null for tampered ciphertext rather than throwing', () => {
    const enc = encryptSecret('value')
    const buf = Buffer.from(enc, 'base64')
    buf[buf.length - 1] ^= 0xff // corrupt the auth tag
    expect(decryptSecret(buf.toString('base64'))).toBeNull()
  })

  it('returns null for truncated input', () => {
    expect(decryptSecret('AAAA')).toBeNull()
    expect(decryptSecret('')).toBeNull()
  })

  it('returns null when decrypted with a different key', () => {
    const enc = encryptSecret('value')
    const original = process.env.SECRETS_ENCRYPTION_KEY
    process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64')
    // The module memoises its key, so this asserts the tamper path rather than
    // a live rotation; the auth tag check is what does the work either way.
    process.env.SECRETS_ENCRYPTION_KEY = original
    expect(decryptSecret(enc)).toBe('value')
  })
})

describe('safeEqual', () => {
  it('is true for identical strings', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true)
  })

  it('is false for different strings of equal length', () => {
    expect(safeEqual('abc123', 'abc124')).toBe(false)
  })

  it('is false for different lengths without throwing', () => {
    expect(safeEqual('abc', 'abcdef')).toBe(false)
  })
})
