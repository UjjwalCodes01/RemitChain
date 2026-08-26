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

  /**
   * Operator credential for /api/ops/* — the manual payout review queue.
   * Kept separate from CRON_SECRET: that value is handed to Vercel's scheduler,
   * and a credential that can settle a payment should not be the same string.
   */
  OPS_API_TOKEN: z.string().min(32, 'OPS_API_TOKEN must be at least 32 characters').optional(),

  // ── Notification channels ─────────────────────────────────────────────────
  OTP_CHANNEL: z.enum(['email', 'sms']).default('email'),
  RESEND_API_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  RESEND_FROM: z.string().optional().or(z.literal('').transform(() => undefined)),
  GMAIL_USER: z.string().optional().or(z.literal('').transform(() => undefined)),
  GMAIL_APP_PASSWORD: z.string().optional().or(z.literal('').transform(() => undefined)),
  TWILIO_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),

  // ── Compliance ────────────────────────────────────────────────────────────
  /**
   * Sanctions / PEP screening provider. Required on a production chain — with
   * none configured, `screenTransfer` blocks every send rather than letting
   * unscreened transfers through.
   */
  SCREENING_PROVIDER: z.string().optional().or(z.literal('').transform(() => undefined)),
  /** Identity verification provider for KYC tier grants. */
  KYC_PROVIDER: z.string().optional().or(z.literal('').transform(() => undefined)),

  // ── Payout providers ──────────────────────────────────────────────────────
  RAZORPAY_KEY_ID: z.string().optional().or(z.literal('').transform(() => undefined)),
  RAZORPAY_KEY_SECRET: z.string().optional().or(z.literal('').transform(() => undefined)),
  RAZORPAY_ACCOUNT_NUMBER: z.string().optional().or(z.literal('').transform(() => undefined)),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().or(z.literal('').transform(() => undefined)),

  // ── Web Push ──────────────────────────────────────────────────────────────
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),

  // ── Escape hatches (all default to the safe value) ────────────────────────
  /**
   * Accept the pre-upgrade low-entropy OTP scheme, until this ISO-8601 moment.
   * Kept as a raw string; lib/claim-secret.ts interprets and expires it.
   */
  ALLOW_LEGACY_OTP_SCHEME: z.string().optional().or(z.literal('').transform(() => undefined)),
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
  { key: 'SCREENING_PROVIDER', why: 'sanctions screening; unset means every send is blocked' },
  { key: 'OPS_API_TOKEN', why: 'without it the manual payout review queue is unreachable' },
]

/**
 * Is this module being evaluated by `next build` rather than serving a request?
 *
 * `next build` imports every route module to collect page data, so anything
 * thrown at module scope fails the build. Runtime secrets are the wrong thing
 * to assert there:
 *
 *   - The build and the running service are different contexts. A build box
 *     legitimately has no database URL.
 *   - It is a chicken-and-egg on a first deploy: you cannot ship the code that
 *     reads the variables until the variables are set, and you cannot see the
 *     app to know which ones it wants.
 *   - Worst of all, it means a misconfiguration cannot be FIXED by deploying,
 *     because the fix will not build either.
 *
 * Presence is therefore enforced at runtime, where it belongs and where it is
 * far more visible: routes fail closed, `/api/health` returns 503 naming each
 * missing value, and `pnpm preflight` turns that into a GO/NO-GO before anyone
 * is told the service is open.
 *
 * Shape validation still runs at build, so a malformed key or a bad URL is
 * caught as early as possible.
 */
function isBuildPhase(): boolean {
  return (
    process.env.NEXT_PHASE === 'phase-production-build' ||
    process.env.SKIP_ENV_VALIDATION === 'true'
  )
}

function validateServerEnv(): ServerEnv {
  const parsed = serverSchema.safeParse(process.env)

  const skipRequirements = isBuildPhase()

  if (!parsed.success) {
    console.error('Invalid server environment variables:')
    console.error(parsed.error.flatten().fieldErrors)
    throw new Error('Invalid server environment variables — check .env')
  }

  const data = parsed.data

  if (IS_PRODUCTION_CHAIN && skipRequirements) {
    // Report, but do not throw — the build has to complete so the fix can be
    // deployed. Kept to a single line: `next build` evaluates this module once
    // per worker process, and a multi-line block repeated five times reads like
    // something is looping.
    const missing = REQUIRED_ON_PRODUCTION.filter(({ key }) => !data[key])
    if (missing.length > 0) {
      console.warn(
        `[env] production build: ${missing.length} required value(s) not set — ` +
        `${missing.map(m => m.key).join(', ')}. Checked again at runtime; ` +
        'until they are set /api/health returns 503 and no transfer is accepted.',
      )
    }
  }

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
      // An open-ended legacy window is the failure mode this guard exists for:
      // the flag gets set for a cutover and then nobody removes it, leaving the
      // brute-forceable commitment accepted indefinitely. Require a deadline.
      if (data.ALLOW_LEGACY_OTP_SCHEME === 'true') {
        throw new Error(
          'FATAL: ALLOW_LEGACY_OTP_SCHEME=true is not permitted on a production chain.\n' +
          'Set it to an ISO-8601 timestamp instead, so the legacy window closes by itself:\n' +
          `  ALLOW_LEGACY_OTP_SCHEME=${new Date(Date.now() + 48 * 3600 * 1000).toISOString()}\n` +
          'The pre-upgrade OTP commitment is brute-forceable from public chain data, so this ' +
          'window must be bounded.',
        )
      }

      const expiry = Date.parse(data.ALLOW_LEGACY_OTP_SCHEME)
      if (Number.isNaN(expiry)) {
        throw new Error(
          `FATAL: ALLOW_LEGACY_OTP_SCHEME is "${data.ALLOW_LEGACY_OTP_SCHEME}", which is not a ` +
          'valid ISO-8601 timestamp.',
        )
      }

      const hoursLeft = Math.round((expiry - Date.now()) / 3_600_000)
      if (hoursLeft > 72) {
        throw new Error(
          `FATAL: ALLOW_LEGACY_OTP_SCHEME expires in ${hoursLeft}h. The claim window is 48h, ` +
          'so anything beyond 72h keeps a known-weak commitment accepted for no reason.',
        )
      }

      console.warn(
        hoursLeft > 0
          ? `[env] Legacy OTP scheme accepted for another ${hoursLeft}h, then automatically refused.`
          : '[env] ALLOW_LEGACY_OTP_SCHEME has expired and is no longer in effect. Remove it.',
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
