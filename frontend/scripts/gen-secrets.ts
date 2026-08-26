#!/usr/bin/env tsx
/**
 * scripts/gen-secrets.ts
 *
 * Generates every secret the application needs, in the exact format each one is
 * validated against.
 *
 * LAUNCH.md §4 listed three `node -e "require('crypto')…"` one-liners to copy
 * by hand. Two of the values are permanent — get the encoding wrong and the app
 * refuses to boot; lose them and every in-flight transfer is stranded — so they
 * should not be assembled from a runbook snippet under time pressure.
 *
 * Prints to stdout only. Nothing is written to disk, so nothing can be
 * committed by accident.
 *
 * Usage:  pnpm gen:secrets
 */

import { randomBytes } from 'node:crypto'

interface Secret {
  name: string
  value: string
  permanent: boolean
  note: string
}

const secrets: Secret[] = [
  {
    name: 'SECRETS_ENCRYPTION_KEY',
    value: randomBytes(32).toString('base64'),
    permanent: true,
    note: 'AES-256-GCM key for claim secrets and OTPs at rest',
  },
  {
    name: 'PHONE_HASH_PEPPER',
    value: '0x' + randomBytes(32).toString('hex'),
    permanent: true,
    note: 'keys the on-chain phone commitment and the screening subject hashes',
  },
  {
    name: 'CRON_SECRET',
    value: randomBytes(32).toString('hex'),
    permanent: false,
    note: 'authenticates the payout worker and event poller',
  },
  {
    name: 'OPS_API_TOKEN',
    value: randomBytes(32).toString('hex'),
    permanent: false,
    note: 'operator credential for the manual payout review queue',
  },
]

console.log(`
\x1b[1mRemitChain — generated secrets\x1b[0m

\x1b[41m\x1b[97m  DO NOT PASTE THIS OUTPUT ANYWHERE  \x1b[0m

Not into a chat, a ticket, a commit, a screenshot or a terminal recording.
Type or copy each value straight into your secret store. Anything below that is
seen by a third party must be regenerated before you deploy with it — and the
two PERMANENT values cannot be rotated after launch without breaking pending
transfers, so a leak found later is not recoverable.

Printed once. Nothing is written to disk.
`)

for (const s of secrets) {
  const tag = s.permanent
    ? '\x1b[31m\x1b[1m[PERMANENT]\x1b[0m'
    : '\x1b[33m[rotatable]\x1b[0m'
  console.log(`${tag} \x1b[1m${s.name}\x1b[0m`)
  console.log(`  ${s.note}`)
  console.log(`  \x1b[36m${s.name}=${s.value}\x1b[0m\n`)
}

console.log(`\x1b[41m\x1b[97m  If any value above has been seen by anyone else, re-run this now.  \x1b[0m

\x1b[31m\x1b[1mThe two PERMANENT values must be backed up somewhere other than Vercel.\x1b[0m

  SECRETS_ENCRYPTION_KEY  — losing it makes every stored claim secret
                            undecryptable, so pending transfers cannot have
                            their notification re-sent.
  PHONE_HASH_PEPPER       — losing it means no recipient's phone number will
                            ever match its on-chain commitment again. Every
                            pending transfer becomes unclaimable and can only
                            be refunded by its sender after expiry.

Rotating either one has the same effect as losing it. Treat them the way you
would treat a database encryption key.

Also required, but obtained rather than generated:
  DATABASE_URL, UPSTASH_REDIS_REST_URL + TOKEN, RESEND_API_KEY,
  RAZORPAY_KEY_ID / KEY_SECRET / ACCOUNT_NUMBER / WEBHOOK_SECRET,
  SCREENING_PROVIDER, KYC_PROVIDER
`)
