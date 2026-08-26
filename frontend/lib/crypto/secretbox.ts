/**
 * lib/crypto/secretbox.ts
 *
 * Authenticated symmetric encryption for secrets held at rest.
 *
 * Used for the claim secret and the OTP, which must be recoverable so the
 * recipient can ask for the notification to be re-sent, but must NOT be
 * readable by anyone who obtains a copy of the database.
 *
 * AES-256-GCM. Key material comes from SECRETS_ENCRYPTION_KEY (32 bytes,
 * base64). A random 12-byte IV per message; the 16-byte auth tag is appended.
 * Wire format:  base64( iv[12] || ciphertext || tag[16] )
 *
 * SERVER ONLY. Importing this from a client component is a build error because
 * `node:crypto` is not available in the browser bundle.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

let _key: Buffer | null = null

/**
 * Resolve the encryption key. Throws if absent or malformed — this is
 * deliberate: silently degrading to plaintext storage of claim secrets would
 * be worse than failing to boot.
 */
function getKey(): Buffer {
  if (_key) return _key

  const raw = process.env.SECRETS_ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY is not set. Generate one with:\n' +
      "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    )
  }

  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `SECRETS_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes, got ${key.length}. ` +
      'It must be 32 random bytes, base64-encoded.',
    )
  }

  _key = key
  return key
}

/** True when a usable encryption key is configured. Never throws. */
export function isEncryptionConfigured(): boolean {
  try {
    getKey()
    return true
  } catch {
    return false
  }
}

/** Encrypt a UTF-8 string. Returns base64(iv || ciphertext || tag). */
export function encryptSecret(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, ciphertext, tag]).toString('base64')
}

/**
 * Decrypt a value produced by `encryptSecret`.
 * Returns null on any failure (wrong key, tampering, truncation) rather than
 * throwing, so callers can treat an unreadable secret as "not available".
 */
export function decryptSecret(encoded: string): string | null {
  try {
    const key = getKey()
    const buf = Buffer.from(encoded, 'base64')
    if (buf.length < IV_BYTES + TAG_BYTES + 1) return null

    const iv = buf.subarray(0, IV_BYTES)
    const tag = buf.subarray(buf.length - TAG_BYTES)
    const ciphertext = buf.subarray(IV_BYTES, buf.length - TAG_BYTES)

    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/**
 * Constant-time string comparison. Use for every secret comparison so response
 * timing cannot be used to recover a value byte by byte.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  // timingSafeEqual throws on length mismatch, which itself leaks length.
  // Hash-free constant-length guard: compare lengths without early return.
  if (ab.length !== bb.length) {
    // Still burn a comparison so the timing profile is flat.
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}
