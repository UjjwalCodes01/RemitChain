/**
 * lib/claim-secret.ts
 *
 * Derivation of the on-chain OTP commitment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The previous scheme committed to the OTP as:
 *
 *     otpReveal      = bytes32(uint256(<6-digit OTP>))
 *     otpCommitHash  = keccak256(abi.encode(otpReveal, transferId, relayer))
 *
 * `transferId` and `relayer` are both public on-chain values and the OTP has
 * only 900,000 possible values, so `otpCommitHash` — which `getTransfer()`
 * returns to anyone who asks — had roughly 20 bits of preimage entropy. Any
 * observer could recover the OTP for any pending transfer in well under a
 * second on a laptop. Rate limiting the API does not help: the attack is
 * offline against public data.
 *
 * The fix keeps the deployed contract unchanged (it only ever compares
 * `keccak256(abi.encode(otpReveal, transferId, recipient))` against a stored
 * bytes32) and changes what `otpReveal` *is*:
 *
 *     claimSecret    = 32 cryptographically random bytes, delivered in the
 *                      claim link and never written to the chain
 *     otpReveal      = keccak256(abi.encodePacked(claimSecret, otpDigits))
 *     otpCommitHash  = keccak256(abi.encode(otpReveal, transferId, recipient))
 *
 * Recovering `otpReveal` from the on-chain commitment now requires guessing a
 * 256-bit secret. The 6-digit OTP remains as a human second factor: possession
 * of the link alone is not enough, and the OTP is guarded by the durable
 * per-transfer attempt lock.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BACKWARD COMPATIBILITY
 * ─────────────────────────────────────────────────────────────────────────────
 * Transfers created under the legacy scheme are still claimable — see
 * `legacyOtpReveal`. The claim route tries the modern derivation first and
 * falls back to the legacy one so in-flight transfers are not stranded by the
 * cutover. Legacy derivation is refused entirely once
 * ALLOW_LEGACY_OTP_SCHEME is unset, which should happen once every transfer
 * predating the upgrade has expired (48 hours after cutover).
 */

import { keccak256, encodeAbiParameters, encodePacked, toHex, type Hex } from 'viem'
import { randomBytes, randomInt } from 'node:crypto'

// ─── Generation (server only) ────────────────────────────────────────────────

export interface ClaimCredentials {
  /** 32 random bytes, base64url. Travels in the claim link. */
  claimSecret: string
  /** 6 decimal digits. Typed by the recipient. */
  otp: string
}

/** base64url encode without padding — safe to place in a URL path or query. */
function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

/**
 * Mint a fresh claim secret and OTP.
 *
 * The OTP uses `randomInt`, which is rejection-sampled and uniform. The old
 * implementation used `Math.floor(100000 + Math.random() * 900000)` in the
 * browser — `Math.random()` is not a CSPRNG and its output is predictable from
 * observed values in several engines.
 */
export function generateClaimCredentials(): ClaimCredentials {
  return {
    claimSecret: toBase64Url(randomBytes(32)),
    otp: String(randomInt(0, 1_000_000)).padStart(6, '0'),
  }
}

// ─── Derivation (shared, deterministic) ──────────────────────────────────────

export const CLAIM_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/
export const OTP_PATTERN = /^\d{6}$/

/**
 * otpReveal = keccak256(abi.encodePacked(claimSecret, otp))
 *
 * `claimSecret` is hashed as raw bytes (not as its base64url text) so the
 * preimage carries the full 256 bits.
 */
export function deriveOtpReveal(claimSecret: string, otp: string): Hex {
  const secretBytes = fromBase64Url(claimSecret)
  if (secretBytes.length !== 32) {
    throw new Error('claimSecret must decode to exactly 32 bytes')
  }
  return keccak256(
    encodePacked(
      ['bytes32', 'string'],
      [toHex(secretBytes) as Hex, otp],
    ),
  )
}

/**
 * otpCommitHash = keccak256(abi.encode(otpReveal, transferId, recipient))
 *
 * This encoding is fixed by the deployed `RemitChain.claimRemittance` and must
 * not change.
 */
export function deriveOtpCommitHash(otpReveal: Hex, transferId: Hex, recipient: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }],
      [otpReveal, transferId, recipient],
    ),
  )
}

/** Convenience: secret + OTP → the commitment stored on-chain. */
export function deriveCommitment(
  claimSecret: string,
  otp: string,
  transferId: Hex,
  recipient: Hex,
): { otpReveal: Hex; otpCommitHash: Hex } {
  const otpReveal = deriveOtpReveal(claimSecret, otp)
  return { otpReveal, otpCommitHash: deriveOtpCommitHash(otpReveal, transferId, recipient) }
}

// ─── Legacy scheme (accepted for in-flight transfers only) ───────────────────

/**
 * The pre-upgrade derivation: the OTP itself, zero-padded to 32 bytes.
 * Only used to let transfers created before the cutover still be claimed.
 */
export function legacyOtpReveal(otp: string): Hex {
  return toHex(BigInt(otp), { size: 32 })
}

/**
 * Whether the legacy low-entropy scheme may still be accepted on claim.
 *
 * ALLOW_LEGACY_OTP_SCHEME takes an ISO-8601 timestamp, not a boolean, and stops
 * having any effect once that moment passes.
 *
 * The flag exists so the upgrade does not strand transfers created under the
 * old scheme, which stay claimable for 48 hours. But while it is set, the
 * brute-forceable commitment this release fixes is still accepted — so the
 * dangerous state is "someone forgot to remove it", and a runbook step saying
 * "confirm you removed it" is not a control. An expiry that the code enforces
 * is.
 *
 * `true` is still accepted for local development, where nothing is at stake.
 * On a production chain it is refused at boot (lib/env.server.ts), which forces
 * a deadline to be chosen up front.
 */
export function isLegacySchemeAllowed(): boolean {
  const value = process.env.ALLOW_LEGACY_OTP_SCHEME
  if (!value) return false
  if (value === 'true') return true

  const expiry = Date.parse(value)
  if (Number.isNaN(expiry)) return false
  return Date.now() < expiry
}

/** When the legacy window closes, or null if it is not time-bounded. */
export function legacySchemeExpiresAt(): number | null {
  const value = process.env.ALLOW_LEGACY_OTP_SCHEME
  if (!value || value === 'true') return null
  const expiry = Date.parse(value)
  return Number.isNaN(expiry) ? null : expiry
}
