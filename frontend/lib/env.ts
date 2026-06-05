import { z } from 'zod'

const envSchema = z.object({
  NEXT_PUBLIC_CHAIN_ID: z
    .string()
    .default('1983')
    .transform(Number)
    .pipe(z.number().int().positive()),
  NEXT_PUBLIC_RPC_URL: z
    .string()
    .url()
    .default('https://rpc1testnet.qie.digital/'),
  NEXT_PUBLIC_WC_PROJECT_ID: z.string().optional(),
  NEXT_PUBLIC_RELAYER_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid EVM address')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  RELAYER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a 32-byte hex string starting with 0x')
    .optional()
    .or(z.literal('').transform(() => undefined)),

  // App URL (used for claim links in email/SMS)
  NEXT_PUBLIC_APP_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),

  // Web Push (VAPID)
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),

  // Vercel KV — for recurring schedules + push subscriptions
  KV_REST_API_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  KV_REST_API_TOKEN: z.string().optional().or(z.literal('').transform(() => undefined)),

  // Twilio SMS (server-only, optional — degrades to stub when absent)
  TWILIO_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),

  // Vercel cron secret
  CRON_SECRET: z.string().optional(),

  // Neon Postgres
  DATABASE_URL: z.string().optional().or(z.literal('').transform(() => undefined)),

  // Upstash Redis (rate limiting + caching)
  UPSTASH_REDIS_REST_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional().or(z.literal('').transform(() => undefined)),

  // Razorpay (UPI off-ramp sandbox)
  RAZORPAY_KEY_ID: z.string().optional().or(z.literal('').transform(() => undefined)),
  RAZORPAY_KEY_SECRET: z.string().optional().or(z.literal('').transform(() => undefined)),

  // ── Email OTP — Resend (free tier, production channel on mainnet) ────────────
  // Sign up at resend.com — 3,000 emails/month free.
  // RESEND_FROM: e.g. "RemitChain <onboarding@resend.dev>" (no domain needed for demo)
  RESEND_API_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  RESEND_FROM: z.string().optional().or(z.literal('').transform(() => undefined)),

  // OTP_CHANNEL: selects the notification channel.
  //   'email' — Resend (default on mainnet, zero cost)
  //   'sms'   — Twilio (optional, kept for backward compatibility)
  //   'demo'  — on-screen only, testnet only
  OTP_CHANNEL: z.enum(['email', 'sms', 'demo']).default('email'),

  // ── Judge Access Token (mainnet-safe alternative to demo mode) ───────────────
  // A scoped unguessable token. When ?judge=<token> is present, the sender's
  // own current-session transfers surface their OTP on the success screen.
  // Public users never see OTPs. Only valid for the judge's own transfers.
  JUDGE_ACCESS_TOKEN: z.string().optional().or(z.literal('').transform(() => undefined)),

  // ── Demo Mode ────────────────────────────────────────────────────────────────
  // Surfaces plaintext OTPs on-screen so judges can test without SMS/email.
  // NEXT_PUBLIC_DEMO_MODE: frontend affordances (demo banner, OTP card).
  // DEMO_MODE:             server-only — controls the demo-otp API endpoint.
  // SAFETY GUARD: DEMO_MODE + QIE Mainnet chainId (1990) = boot-time fatal error.
  NEXT_PUBLIC_DEMO_MODE: z.string().optional().transform(v => v === 'true').default('false'),
  DEMO_MODE: z.string().optional().transform(v => v === 'true').default('false'),
})

// Chain IDs where Demo Mode is FORBIDDEN (real funds at stake)
const PRODUCTION_CHAIN_IDS = [
  1,    // Ethereum mainnet
  1990, // QIE mainnet
]

function validateEnv() {
  const parsed = envSchema.safeParse({
    NEXT_PUBLIC_CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID,
    NEXT_PUBLIC_RPC_URL: process.env.NEXT_PUBLIC_RPC_URL,
    NEXT_PUBLIC_WC_PROJECT_ID: process.env.NEXT_PUBLIC_WC_PROJECT_ID,
    NEXT_PUBLIC_RELAYER_ADDRESS: process.env.NEXT_PUBLIC_RELAYER_ADDRESS,
    RELAYER_PRIVATE_KEY: process.env.RELAYER_PRIVATE_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    TWILIO_SID: process.env.TWILIO_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_FROM: process.env.TWILIO_FROM,
    CRON_SECRET: process.env.CRON_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM: process.env.RESEND_FROM,
    OTP_CHANNEL: process.env.OTP_CHANNEL,
    JUDGE_ACCESS_TOKEN: process.env.JUDGE_ACCESS_TOKEN,
    NEXT_PUBLIC_DEMO_MODE: process.env.NEXT_PUBLIC_DEMO_MODE,
    DEMO_MODE: process.env.DEMO_MODE,
  })

  if (!parsed.success) {
    console.error('❌ Invalid environment variables:')
    console.error(parsed.error.flatten().fieldErrors)
    throw new Error('Invalid environment variables — check .env')
  }

  // ── Production safety guard ──────────────────────────────────────────────────
  // Demo Mode surfaces plaintext OTPs on-screen. This is NEVER acceptable
  // on production chains where real funds are at stake. This check makes it
  // structurally impossible to ship Demo Mode to mainnet by accident.
  if (parsed.data.DEMO_MODE && PRODUCTION_CHAIN_IDS.includes(parsed.data.NEXT_PUBLIC_CHAIN_ID)) {
    throw new Error(
      `FATAL: DEMO_MODE cannot be enabled on a production chain (chainId=${parsed.data.NEXT_PUBLIC_CHAIN_ID}). ` +
      `Surfacing OTPs on-screen on mainnet is a critical security vulnerability. ` +
      `Disable DEMO_MODE=false or switch to a testnet chain ID (e.g. 1983).`
    )
  }

  return parsed.data
}

export const env = validateEnv()
