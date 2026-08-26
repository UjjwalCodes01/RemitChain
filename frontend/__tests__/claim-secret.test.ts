/**
 * Tests for the OTP commitment scheme.
 *
 * The property under test is the one the old scheme failed: the value written
 * on-chain must not be invertible from public data.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { keccak256, encodeAbiParameters, toHex } from 'viem'
import {
  generateClaimCredentials,
  deriveOtpReveal,
  deriveOtpCommitHash,
  deriveCommitment,
  legacyOtpReveal,
  CLAIM_SECRET_PATTERN,
  OTP_PATTERN,
} from '@/lib/claim-secret'

const TRANSFER_ID = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const RELAYER = '0x57B459fE76d0Db566E3CA71B3CED6F949539Fb39' as const

describe('generateClaimCredentials', () => {
  it('produces a 43-char base64url secret and a 6-digit OTP', () => {
    const { claimSecret, otp } = generateClaimCredentials()
    expect(claimSecret).toMatch(CLAIM_SECRET_PATTERN)
    expect(otp).toMatch(OTP_PATTERN)
  })

  it('can produce OTPs with leading zeros', () => {
    // `String(n).padStart(6,'0')` must be used, not arithmetic that forces a
    // 100000..999999 range — otherwise a tenth of the keyspace is unreachable
    // and every OTP starts with 1-9.
    const otps = Array.from({ length: 4000 }, () => generateClaimCredentials().otp)
    expect(otps.every(o => OTP_PATTERN.test(o))).toBe(true)
    expect(otps.some(o => o.startsWith('0'))).toBe(true)
  })

  it('never repeats a secret across many draws', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generateClaimCredentials().claimSecret))
    expect(seen.size).toBe(2000)
  })
})

describe('deriveOtpReveal', () => {
  it('is deterministic for the same secret and OTP', () => {
    const { claimSecret } = generateClaimCredentials()
    expect(deriveOtpReveal(claimSecret, '123456')).toBe(deriveOtpReveal(claimSecret, '123456'))
  })

  it('changes when the OTP changes', () => {
    const { claimSecret } = generateClaimCredentials()
    expect(deriveOtpReveal(claimSecret, '123456')).not.toBe(deriveOtpReveal(claimSecret, '123457'))
  })

  it('changes when the secret changes', () => {
    const a = generateClaimCredentials().claimSecret
    const b = generateClaimCredentials().claimSecret
    expect(deriveOtpReveal(a, '123456')).not.toBe(deriveOtpReveal(b, '123456'))
  })

  it('rejects a secret that is not 32 bytes', () => {
    expect(() => deriveOtpReveal('too-short', '123456')).toThrow()
  })
})

describe('deriveOtpCommitHash', () => {
  it('matches the encoding the deployed contract verifies', () => {
    // RemitChain.claimRemittance computes:
    //   keccak256(abi.encode(otpReveal, transferId, recipient))
    const { claimSecret } = generateClaimCredentials()
    const reveal = deriveOtpReveal(claimSecret, '246810')

    const manual = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }],
        [reveal, TRANSFER_ID, RELAYER],
      ),
    )

    expect(deriveOtpCommitHash(reveal, TRANSFER_ID, RELAYER)).toBe(manual)
  })

  it('binds the commitment to the recipient address', () => {
    const { claimSecret } = generateClaimCredentials()
    const reveal = deriveOtpReveal(claimSecret, '111111')
    const other = '0x000000000000000000000000000000000000dEaD' as const
    expect(deriveOtpCommitHash(reveal, TRANSFER_ID, RELAYER))
      .not.toBe(deriveOtpCommitHash(reveal, TRANSFER_ID, other))
  })

  it('binds the commitment to the transfer id', () => {
    const { claimSecret } = generateClaimCredentials()
    const reveal = deriveOtpReveal(claimSecret, '111111')
    const otherId = ('0x' + 'cd'.repeat(32)) as `0x${string}`
    expect(deriveOtpCommitHash(reveal, TRANSFER_ID, RELAYER))
      .not.toBe(deriveOtpCommitHash(reveal, otherId, RELAYER))
  })
})

describe('brute-force resistance (the vulnerability this scheme fixes)', () => {
  it('LEGACY: the on-chain commitment was invertible by trying every OTP', () => {
    // Everything an attacker needs was public: `transferId` and `recipient`
    // come straight from getTransfer(), and the OTP had under a million
    // possible values.
    const victimOtp = '481922'
    const onChainCommit = deriveOtpCommitHash(legacyOtpReveal(victimOtp), TRANSFER_ID, RELAYER)

    let recovered: string | null = null
    // Search a 2,000-wide window around the answer. The real attack scans the
    // full million in well under a second; this keeps the test fast while
    // demonstrating the same computation.
    for (let i = 481_000; i < 483_000; i++) {
      const candidate = String(i).padStart(6, '0')
      if (deriveOtpCommitHash(legacyOtpReveal(candidate), TRANSFER_ID, RELAYER) === onChainCommit) {
        recovered = candidate
        break
      }
    }

    expect(recovered).toBe(victimOtp)
  })

  it('CURRENT: the same search recovers nothing without the claim secret', () => {
    const { claimSecret } = generateClaimCredentials()
    const victimOtp = '481922'
    const onChainCommit = deriveCommitment(claimSecret, victimOtp, TRANSFER_ID, RELAYER).otpCommitHash

    // The attacker knows transferId and recipient, and now guesses the OTP —
    // but the preimage also contains 256 bits they do not have.
    let recovered: string | null = null
    for (let i = 481_000; i < 483_000; i++) {
      const candidate = String(i).padStart(6, '0')
      if (deriveOtpCommitHash(legacyOtpReveal(candidate), TRANSFER_ID, RELAYER) === onChainCommit) {
        recovered = candidate
        break
      }
    }

    expect(recovered).toBeNull()
  })

  it('CURRENT: the correct secret plus the correct OTP still verifies', () => {
    const { claimSecret, otp } = generateClaimCredentials()
    const { otpCommitHash } = deriveCommitment(claimSecret, otp, TRANSFER_ID, RELAYER)

    const reproduced = deriveOtpCommitHash(
      deriveOtpReveal(claimSecret, otp),
      TRANSFER_ID,
      RELAYER,
    )
    expect(reproduced).toBe(otpCommitHash)
  })

  it('CURRENT: the right secret with the wrong OTP does not verify', () => {
    const { claimSecret, otp } = generateClaimCredentials()
    const { otpCommitHash } = deriveCommitment(claimSecret, otp, TRANSFER_ID, RELAYER)
    const wrong = otp === '000000' ? '000001' : '000000'

    expect(deriveOtpCommitHash(deriveOtpReveal(claimSecret, wrong), TRANSFER_ID, RELAYER))
      .not.toBe(otpCommitHash)
  })
})

describe('legacyOtpReveal', () => {
  it('reproduces the pre-upgrade encoding so in-flight transfers still claim', () => {
    expect(legacyOtpReveal('123456')).toBe(toHex(BigInt('123456'), { size: 32 }))
  })
})
