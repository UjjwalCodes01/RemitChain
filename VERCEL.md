# Vercel Deployment

Everything to configure in Vercel, in the order you should do it.
For the wider launch sequence (contracts, provider accounts, compliance) see
[`LAUNCH.md`](LAUNCH.md).

---

## 1. Project settings

| Setting | Value | Why |
|---|---|---|
| **Root Directory** | `frontend` | The repo is a monorepo; the Next.js app is not at the root. |
| **Framework Preset** | Next.js | Auto-detected. |
| **Build Command** | *(leave default)* | `next build`. Do **not** add `SKIP_ENV_VALIDATION` — you want the build to fail if config is wrong. |
| **Install Command** | *(leave default)* | `pnpm install --frozen-lockfile`, detected from `pnpm-lock.yaml`. |
| **Node.js Version** | **22.x** | Pinned by `engines` in `package.json`. |
| **Region** | Pick one close to your database | Every route hits Neon; cross-region adds latency to money-moving requests. If your Neon project is in `aws-ap-south-1`, use `bom1`. |

**Plan: you need Pro.** Two hard reasons, not preferences:

1. **Cron frequency.** Hobby permits only *daily* crons. `/api/cron/payouts` is
   scheduled every 2 minutes and is the reliability guarantee behind every
   payout — retries, webhook reconciliation, and orphan repair all run there.
   On Hobby it effectively never runs, and a payout that fails its first attempt
   stays failed for up to 24 hours.
2. **Function duration.** Claiming broadcasts a transaction and waits for its
   receipt. The routes declare `maxDuration` up to 60s; Hobby caps at 10s, so
   every claim would time out.

---

## 2. Environment variables

Add these under **Settings → Environment Variables**. Scope them to
**Production**, and give Preview its own testnet values.

`frontend/.env.example` documents every variable in full. This is the
deployment-ordered checklist.

### Required — the app will not boot without these on mainnet

| Variable | Value / how to get it |
|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | `1990` |
| `NEXT_PUBLIC_RPC_URL` | `https://rpc1mainnet.qie.digital/` |
| `NEXT_PUBLIC_APP_URL` | `https://your-domain.com` — no trailing slash |
| `NEXT_PUBLIC_RELAYER_ADDRESS` | The relayer's public address |
| `RELAYER_PRIVATE_KEY` | The relayer key. **Mark as Sensitive.** |
| `DATABASE_URL` | Neon pooled connection string, with `?sslmode=require` |
| `UPSTASH_REDIS_REST_URL` | From the Upstash console |
| `UPSTASH_REDIS_REST_TOKEN` | From the Upstash console. **Sensitive.** |
| `SECRETS_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` **Sensitive. Back it up.** |
| `PHONE_HASH_PEPPER` | `node -e "console.log('0x'+require('crypto').randomBytes(32).toString('hex'))"` **Sensitive. Back it up.** |
| `CRON_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` **Sensitive.** |

`SECRETS_ENCRYPTION_KEY` and `PHONE_HASH_PEPPER` are **permanent**. Rotating
either one strands every in-flight transfer — the phone commitment stops
matching and claim secrets stop decrypting. Store them wherever you would store
a database encryption key, not only in Vercel.

### Required for anyone to actually get paid

| Variable | Notes |
|---|---|
| `RAZORPAY_KEY_ID` | Must start `rzp_live_` on mainnet. A `rzp_test_` key is **refused at boot**. |
| `RAZORPAY_KEY_SECRET` | **Sensitive.** |
| `RAZORPAY_ACCOUNT_NUMBER` | Your RazorpayX **virtual account** number — the source of funds, not your bank account number. |
| `RAZORPAY_WEBHOOK_SECRET` | From Razorpay Dashboard → Settings → Webhooks. **Sensitive.** Boot fails without it when live payouts are configured. |

Without all four, the India/UPI corridor stays closed, and with no open corridor
nobody can send at all.

### Required for the recipient to receive their claim code

Pick one:

| Option | Variables |
|---|---|
| Resend *(recommended)* | `RESEND_API_KEY`, `RESEND_FROM` |
| Gmail SMTP | `GMAIL_USER`, `GMAIL_APP_PASSWORD` |
| Twilio SMS | `OTP_CHANNEL=sms`, `TWILIO_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |

Verify your sending domain. A claim code in a spam folder is a transfer that
never completes, and the funds sit until they expire.

### Optional

| Variable | Default | Notes |
|---|---|---|
| `OTP_CHANNEL` | `email` | `email` or `sms` |
| `FX_MAX_STALENESS_MINUTES` | `60` | How old a rate may be and still back a quote. Beyond it, corridors close rather than quote on stale data. |
| `STATS_BENCHMARK_FEE_PCT` | `0.062` | Baseline for the "fees saved" figure on `/stats`. Default is the World Bank global average. |
| `KYC_PROVIDER` | *(unset)* | Until set, `/api/kyc/upgrade` refuses to raise anyone's tier on mainnet. |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | | Web Push. `npx web-push generate-vapid-keys` |
| `NEXT_PUBLIC_WC_PROJECT_ID` | | WalletConnect |

### Do not set on production

`ALLOW_LEGACY_OTP_SCHEME` is the sole exception — see the cutover step below.
`ENABLE_SANDBOX_PAYOUTS` and `SKIP_ENV_VALIDATION` must never be set on
Production. The first is refused at boot; the second would let a misconfigured
deployment build successfully.

---

## 3. Cron jobs

Already declared in `frontend/vercel.json` — no dashboard configuration needed.
Vercel sends `Authorization: Bearer $CRON_SECRET` automatically.

| Path | Schedule | Purpose |
|---|---|---|
| `/api/cron/payouts` | `*/2 * * * *` | Submits due payouts, retries failures, reconciles against the provider, repairs orphaned claims. **This is the one that must run.** |
| `/api/cron/poll-events` | `*/5 * * * *` | Catches on-chain events the app missed. |
| `/api/cron/recurring` | `0 9 * * *` | Daily transfer reminders. |

After the first deploy, confirm under **Deployments → Crons** that all three are
registered and succeeding. A failing payout cron is invisible from the UI — the
product looks fine while payouts silently queue.

---

## 4. Webhook

In the Razorpay Dashboard → Settings → Webhooks:

- **URL:** `https://your-domain.com/api/webhooks/razorpay`
- **Events:** `payout.processed`, `payout.failed`, `payout.reversed`,
  `payout.updated`, `payout.rejected`
- **Secret:** the same value as `RAZORPAY_WEBHOOK_SECRET`

Register this against your **custom domain**, not a `*.vercel.app` preview URL —
preview URLs change on every deployment.

Signatures are verified against the raw request body, and every event is
de-duplicated by Razorpay's event id, so redeliveries are safe.

---

## 5. Domain

**Settings → Domains** → add your domain and follow the DNS instructions.

Then set `NEXT_PUBLIC_APP_URL` to it and **redeploy** — it is a `NEXT_PUBLIC_*`
variable, so it is baked in at build time. Changing it without rebuilding leaves
the old value in the bundle.

It matters more than usual here: claim links in recipient emails are built from
it. Wrong value, and every recipient gets a dead link.

`robots.ts` and `sitemap.ts` derive from the same variable, so no separate SEO
configuration is needed. Non-production chains are set to `Disallow: /`, so a
testnet deployment cannot be indexed.

---

## 6. Database

Vercel does not run migrations for you. Before the first production deploy:

```bash
cd frontend
DATABASE_URL="<your production URL>" pnpm db:migrate
```

Applies `0000` → `0002`, tracked in a `_migrations` table so it is safe to
re-run and safe to add to your deploy pipeline.

**Snapshot the database first** — `0001` drops columns after backfilling them
into the new payout ledger.

---

## 7. Deploy order

1. Deploy contracts and accept ownership from the Safe (`LAUNCH.md` §1)
2. `pnpm sync:abis`, commit the updated `lib/contracts.ts`
3. Set all environment variables in Vercel
4. Run migrations against production
5. Deploy
6. Register the Razorpay webhook against the live domain
7. Fund the relayer with gas, and the RazorpayX virtual account with rupees
8. Verify (below)

---

## 8. Verify

```bash
curl -s https://your-domain.com/api/health | jq
```

Expect **HTTP 200** and `"status": "ok"`. Anything else returns **503** and
names what is wrong. Confirm:

- every entry under `services` is configured — none reading `MISSING`
- `summary.corridorsLive` ≥ 1
- `corridors[].live` is `true` for the corridor you are opening
  (`live: false` means a simulated rail, which cannot occur on mainnet)

Then check the crons have run, and send one real transfer at the minimum amount
to an account you control. The full end-to-end checklist is in `LAUNCH.md` §7 —
the part that matters is confirming the **rupees actually arrive**, and that the
amount matches the quote.

---

## 9. Cutover flag

The OTP and phone-hash schemes changed in this release. Transfers created by the
old build cannot verify under the new one.

1. First production deploy: set `ALLOW_LEGACY_OTP_SCHEME=true`
2. Wait **48 hours** — the full claim window, after which every pre-upgrade
   transfer has been claimed or has expired
3. **Remove the variable and redeploy**

Step 3 is easy to forget. While the flag is set, the old brute-forceable
commitment is still accepted, which is the vulnerability this release fixes. The
app logs a warning on every boot as a reminder.

---

## 10. After launch

**Log Drains** (Settings → Log Drains) — route logs somewhere you can alert on.
Everything is structured JSON. Page on:

- `payout.orphaned_claim_unrecoverable` — a recipient is owed money and we do not know where to send it
- `payout.attempt_failed` with `ambiguous: true` — we cannot tell whether money moved; never auto-retried
- `claim.relayer_out_of_gas` — every claim is failing

**Watch balances.** The relayer's gas and the RazorpayX virtual account are the
two things that stop the product dead when they run out, and neither is visible
from the app.

**Deployment Protection.** If you enable password protection or Vercel
Authentication on Production, exempt `/api/webhooks/*` and `/api/cron/*` — a
protected webhook endpoint silently drops every settlement confirmation.
