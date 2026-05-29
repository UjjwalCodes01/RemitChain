import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from '@simplewebauthn/browser'

/** Encode a Uint8Array as a base64url string (no padding) */
function toBase64Url(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

const CRED_KEY = 'remitchain:biometric:credId'
const REGISTERED_KEY = 'remitchain:biometric:registered'

export { browserSupportsWebAuthn }

export async function isBiometricRegistered(): Promise<boolean> {
  if (typeof window === 'undefined') return false
  const { get } = await import('idb-keyval')
  const flag = await get<boolean>(REGISTERED_KEY)
  return flag === true
}

/**
 * Register a biometric credential.
 * Uses the Web Authentication API (WebAuthn / FIDO2).
 * The credential never leaves the device.
 */
export async function registerBiometric(userId: string, userName: string): Promise<boolean> {
  if (typeof window === 'undefined') return false
  const { set } = await import('idb-keyval')
  try {
    const opts = {
      challenge: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
      rp: { name: 'RemitChain', id: window.location.hostname },
      user: {
        id: userId,  // SimpleWebAuthn browser v13 accepts string user IDs
        name: userName,
        displayName: userName,
      },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' as const },   // ES256
        { alg: -257, type: 'public-key' as const },  // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform' as const,
        requireResidentKey: false,
        userVerification: 'required' as const,
      },
      timeout: 60000,
      attestation: 'none' as const,
    }

    const reg = await startRegistration({ optionsJSON: opts })
    await set(CRED_KEY, reg.id)
    await set(REGISTERED_KEY, true)
    return true
  } catch {
    return false
  }
}

/**
 * Verify biometric — prompts Face ID / fingerprint.
 * Returns true if verified.
 */
export async function verifyBiometric(): Promise<boolean> {
  if (typeof window === 'undefined') return false
  const { get } = await import('idb-keyval')
  try {
    const credId = await get<string>(CRED_KEY)
    if (!credId) return false

    const opts = {
      challenge: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
      allowCredentials: [{ id: credId, type: 'public-key' as const }],
      userVerification: 'required' as const,
      timeout: 60000,
    }

    await startAuthentication({ optionsJSON: opts })
    return true
  } catch {
    return false
  }
}

export async function removeBiometric(): Promise<void> {
  if (typeof window === 'undefined') return
  const { del } = await import('idb-keyval')
  await del(CRED_KEY)
  await del(REGISTERED_KEY)
}
