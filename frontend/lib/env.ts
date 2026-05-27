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
  NEXT_PUBLIC_RELAYER_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid EVM address'),
  RELAYER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a 32-byte hex string starting with 0x')
    .optional(),

  // Web Push (VAPID)
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),

  // Vercel KV — for recurring schedules + push subscriptions
  KV_REST_API_URL: z.string().url().optional(),
  KV_REST_API_TOKEN: z.string().optional(),
})

function validateEnv() {
  const parsed = envSchema.safeParse({
    NEXT_PUBLIC_CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID,
    NEXT_PUBLIC_RPC_URL: process.env.NEXT_PUBLIC_RPC_URL,
    NEXT_PUBLIC_RELAYER_ADDRESS: process.env.NEXT_PUBLIC_RELAYER_ADDRESS,
    RELAYER_PRIVATE_KEY: process.env.RELAYER_PRIVATE_KEY,
  })

  if (!parsed.success) {
    console.error('❌ Invalid environment variables:')
    console.error(parsed.error.flatten().fieldErrors)
    throw new Error('Invalid environment variables — check .env')
  }

  return parsed.data
}

export const env = validateEnv()
