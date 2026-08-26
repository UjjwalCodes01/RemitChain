/**
 * lib/env.server.ts
 *
 * SERVER-ONLY configuration. Importing this from a client component is a build
 * error, enforced by the `server-only` package.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE
 * ─────────────────────────────────────────────────────────────────────────────
 * On a production chain, everything needed to move money safely is REQUIRED.
 * The deployment refuses to boot without it.
 *
 * This is a deliberate reversal. Previously every secret was `.optional()` and
 * each call site degraded on its own — no database meant transfers silently
 * vanished, no encryption key meant claim secrets could not be stored, a
 * missing `CRON_SECRET` meant the cron endpoints were simply open. Individually
 * defensible, collectively a system that looked healthy while being unable to
 * do its job. A remittance service that cannot reach its database should not
 * accept a send.
 */

import 'server-only'
import { z } from 'zod'
import { IS_PRODUCTION_CHAIN, env as publicEnv } from './env'
import { assertPayoutConfigSafe } from './payouts/registry'

const hex32 = z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a 32-byte hex string with an 0x prefix')
const base64_32 = z
  .string()
  .refine(v => Buffer.from(v, 'base64').length === 32, 'Must decode to exactly 32 bytes of base64')

const serverSchema = z.object({
  // ── Relayer ───────────────────────────────────────────────────────────────
  RELAYER_PRIVATE_KEY: hex32.optional(),

  // ── Data stores ───────────────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1).optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional().or(z.literal('').transform(() => undefined)),

  // ── Secret material ───────────────────────────────────────────────────────
  /** Encrypts claim secrets and OTPs at rest. */
  SECRETS_ENCRYPTION_KEY: base64_32.optional(),
  /** Keys the on-chain phone commitment. Permanent — rotating it strands transfers. */
  PHONE_HASH_PEPPER: hex32.optional(),

  // ── Scheduled jobs ────────────────────────────────────────────────────────
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters').optional(),

  // ── Notification channels ─────────────────────────────────────────────────
  OTP_CHANNEL: z.enum(['email', 'sms']).default('email'),
  RESEND_API_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  RESEND_FROM: z.string().optional().or(z.literal('').transform(() => undefined)),
  GMAIL_USER: z.string().optional().or(z.literal('').transform(() => undefined)),
  GMAIL_APP_PASSWORD: z.string().optional().or(z.literal('').transform(() => undefined)),
  TWILIO_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),

  // ── Payout providers ──────────────────────────────────────────────────────
  RAZORPAY_KEY_ID: z.string().optional().or(z.literal('').transform(() => undefined)),
  RAZORPAY_KEY_SECRET: z.string().optional().or(z.literal('').transform(() => undefined)),
  RAZORPAY_ACCOUNT_NUMBER: z.string().optional().or(z.literal('').transform(() => undefined)),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().or(z.literal('').transform(() => undefined)),

  // ── Web Push ──────────────────────────────────────────────────────────────
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),

  // ── Escape hatches (all default to the safe value) ────────────────────────
  /** Accept the pre-upgrade low-entropy OTP scheme for in-flight transfers. */
  ALLOW_LEGACY_OTP_SCHEME: z.string().optional().transform(v => v === 'true').default('false'),
  /**
   * How old an FX rate may be and still back a binding quote, in minutes.
   * Beyond it the corridor closes rather than quoting on stale data.
   */
  FX_MAX_STALENESS_MINUTES: z.coerce.number().int().positive().max(1440).default(60),
  /** Enable the simulated payout rail. Refused on a production chain. */
  ENABLE_SANDBOX_PAYOUTS: z.string().optional().transform(v => v === 'true').default('false'),
})

export type ServerEnv = z.infer<typeof serverSchema>

/** Secrets that must be present before a production chain will accept a send. */
const REQUIRED_ON_PRODUCTION: Array<{ key: keyof ServerEnv; why: string }> = [
  { key: 'RELAYER_PRIVATE_KEY', why: 'signs claim transactions and pays gas' },
  { key: 'DATABASE_URL', why: 'the payout ledger cannot be held in memory' },
  { key: 'SECRETS_ENCRYPTION_KEY', why: 'encrypts claim secrets at rest' },
  { key: 'PHONE_HASH_PEPPER', why: 'keys the phone commitment; a public salt leaks recipients' },
  { key: 'CRON_SECRET', why: 'authenticates the payout worker and event poller' },
  { key: 'UPSTASH_REDIS_REST_URL', why: 'backs distributed rate limiting' },
]

function validateServerEnv(): ServerEnv {
  const parsed = serverSchema.safeParse(process.env)

  // CI and container builds legitimately run `next build` with no secrets
  // present. Parsing still happens so a malformed value is caught; only the
  // "is it present" requirements are deferred to runtime, where a missing
  // secret surfaces as a 503 from /api/health rather than a broken deploy.
  const skipRequirements = process.env.SKIP_ENV_VALIDATION === 'true'

  if (!parsed.success) {
    console.error('Invalid server environment variables:')
    console.error(parsed.error.flatten().fieldErrors)
    throw new Error('Invalid server environment variables — check .env')
  }

  const data = parsed.data

  if (IS_PRODUCTION_CHAIN && !skipRequirements) {
    const missing = REQUIRED_ON_PRODUCTION.filter(({ key }) => !data[key])
    if (missing.length > 0) {
      throw new Error(
        `FATAL: running against production chain ${publicEnv.NEXT_PUBLIC_CHAIN_ID} with missing configuration:\n` +
        missing.map(({ key, why }) => `  - ${key}: ${why}`).join('\n') +
        '\n\nSet these, or point NEXT_PUBLIC_CHAIN_ID at a testnet.',
      )
    }

    if (!publicEnv.NEXT_PUBLIC_RELAYER_ADDRESS) {
      throw new Error('FATAL: NEXT_PUBLIC_RELAYER_ADDRESS is required on a production chain.')
    }

    if (!publicEnv.NEXT_PUBLIC_APP_URL) {
      throw new Error(
        'FATAL: NEXT_PUBLIC_APP_URL is required on a production chain — claim links in ' +
        'emails would otherwise point at a Vercel preview URL or at localhost.',
      )
    }

    if (data.ALLOW_LEGACY_OTP_SCHEME) {
      // Deliberately a warning, not a failure: the flag exists precisely so the
      // production cutover does not strand transfers that are already in
      // flight. It has to be turned off again once they expire.
      console.warn(
        '[env] ALLOW_LEGACY_OTP_SCHEME is enabled on a production chain. The pre-upgrade ' +
        'OTP commitment is brute-forceable from public chain data. Unset this flag once ' +
        'every transfer created before the upgrade has expired (48h).',
      )
    }

    if (data.FX_MAX_STALENESS_MINUTES > 240) {
      console.warn(
        `[env] FX_MAX_STALENESS_MINUTES is ${data.FX_MAX_STALENESS_MINUTES} on a production ` +
        'chain. Quotes may be backed by rates several hours old.',
      )
    }
  }

  // Cross-checks that apply on every chain. These stay on even when
  // requirements are skipped — they catch a configuration that would move
  // money incorrectly, which is never acceptable to defer.
  assertPayoutConfigSafe(IS_PRODUCTION_CHAIN)

  return data
}

export const serverEnv: ServerEnv = validateServerEnv()

// ─── Derived helpers ─────────────────────────────────────────────────────────

/** The relayer key, guaranteed present. Throws rather than returning undefined. */
export function relayerPrivateKey(): `0x${string}` {
  const key = serverEnv.RELAYER_PRIVATE_KEY
  if (!key) throw new Error('RELAYER_PRIVATE_KEY is not configured')
  return key as `0x${string}`
}

export function relayerAddress(): `0x${string}` {
  const addr = publicEnv.NEXT_PUBLIC_RELAYER_ADDRESS
  if (!addr) throw new Error('NEXT_PUBLIC_RELAYER_ADDRESS is not configured')
  return addr as `0x${string}`
}
