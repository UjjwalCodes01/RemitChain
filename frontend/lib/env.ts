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
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid EVM address'),
  RELAYER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a 32-byte hex string starting with 0x')
    .optional(),

  // App URL (used for SMS claim links)
  NEXT_PUBLIC_APP_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),

  // Web Push (VAPID)
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),

  // Vercel KV — for recurring schedules + push subscriptions
  KV_REST_API_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  KV_REST_API_TOKEN: z.string().optional().or(z.literal('').transform(() => undefined)),

  // Twilio SMS (server-only, optional — degrades to stub mode if absent)
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
})

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
  })

  if (!parsed.success) {
    console.error('❌ Invalid environment variables:')
    console.error(parsed.error.flatten().fieldErrors)
    throw new Error('Invalid environment variables — check .env')
  }

  return parsed.data
}

export const env = validateEnv()
