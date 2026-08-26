/**
 * lib/env.ts
 *
 * PUBLIC configuration — safe to import from client components.
 *
 * Only `NEXT_PUBLIC_*` values live here. Next.js inlines those at build time,
 * so anything in this file is visible in the browser bundle by definition.
 *
 * Server secrets live in `lib/env.server.ts`, which is guarded by the
 * `server-only` package and will fail the build if a client component imports
 * it. The previous single `lib/env.ts` validated `RELAYER_PRIVATE_KEY` and
 * every other secret in a module that client components (`app/send/page.tsx`,
 * `app/connect/page.tsx`, `lib/wagmi.ts`) imported directly — the values were
 * `undefined` in the browser, so the schema quietly had to mark every secret
 * optional, which removed the very check that would have caught a missing
 * relayer key at boot.
 */

import { z } from 'zod'

const publicSchema = z.object({
  NEXT_PUBLIC_CHAIN_ID: z
    .string()
    .default('1990')
    .transform(Number)
    .pipe(z.number().int().positive()),

  NEXT_PUBLIC_RPC_URL: z.string().url().default('https://rpc1mainnet.qie.digital/'),

  /**
   * Additional RPC endpoints, comma-separated, tried in order when the primary
   * fails. Every read, send and claim goes through the chain RPC, so a single
   * endpoint is a single point of failure for the whole product.
   */
  NEXT_PUBLIC_RPC_URLS: z.string().optional().or(z.literal('').transform(() => undefined)),

  NEXT_PUBLIC_WC_PROJECT_ID: z.string().optional(),

  /**
   * The address the relayer signs with. Public by nature — it is the on-chain
   * `recipient` for every claim, and the send page needs it to compute the
   * commitment. The matching private key is server-side only.
   */
  NEXT_PUBLIC_RELAYER_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid EVM address')
    .optional()
    .or(z.literal('').transform(() => undefined)),

  NEXT_PUBLIC_APP_URL: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),

  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().optional(),
})

function parsePublicEnv() {
  // Each key must be referenced as a literal `process.env.X` so the Next.js
  // build can statically replace it. Destructuring or dynamic indexing breaks
  // the inlining and yields undefined in the browser.
  const parsed = publicSchema.safeParse({
    NEXT_PUBLIC_CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID,
    NEXT_PUBLIC_RPC_URL: process.env.NEXT_PUBLIC_RPC_URL,
    NEXT_PUBLIC_RPC_URLS: process.env.NEXT_PUBLIC_RPC_URLS,
    NEXT_PUBLIC_WC_PROJECT_ID: process.env.NEXT_PUBLIC_WC_PROJECT_ID,
    NEXT_PUBLIC_RELAYER_ADDRESS: process.env.NEXT_PUBLIC_RELAYER_ADDRESS,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
  })

  if (!parsed.success) {
    console.error('Invalid public environment variables:')
    console.error(parsed.error.flatten().fieldErrors)
    throw new Error('Invalid NEXT_PUBLIC_* environment variables — check .env')
  }

  return parsed.data
}

export const env = parsePublicEnv()

// ─── Chain identity ──────────────────────────────────────────────────────────

/**
 * Chains where real value is at stake. Anything that simulates, reveals a
 * secret, or bypasses a check is forbidden on these.
 */
export const PRODUCTION_CHAIN_IDS = [
  1,    // Ethereum mainnet
  1990, // QIE mainnet
] as const

export const IS_PRODUCTION_CHAIN: boolean = PRODUCTION_CHAIN_IDS.includes(
  env.NEXT_PUBLIC_CHAIN_ID as (typeof PRODUCTION_CHAIN_IDS)[number],
)

/** Absolute base URL for links in emails and SMS. */
export function appUrl(): string {
  if (env.NEXT_PUBLIC_APP_URL) return env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return 'http://localhost:3000'
}
