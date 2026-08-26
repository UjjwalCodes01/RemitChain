# RemitChain — Production Launch Runbook

This is the checklist for taking RemitChain live with real money. Work through
it in order. Steps marked **BLOCKING** must be complete before the app will
accept a single transfer — most of them are enforced in code, so skipping one
means the deployment refuses to boot rather than failing quietly later.

---

## 0. What is already enforced for you

You do not have to remember these. The system refuses to run without them.

| Guard | Where | What happens if you get it wrong |
|---|---|---|
| Required secrets on mainnet | `lib/env.server.ts` | App throws at boot, listing exactly what is missing and why |
| Simulated payouts on mainnet | `lib/payouts/registry.ts` | App throws at boot |
| `rzp_test_` key on mainnet | `lib/payouts/registry.ts` | App throws at boot |
| Live payouts without a webhook secret | `lib/payouts/registry.ts` | App throws at boot |
| A corridor with no payout provider | `lib/corridors.ts` | Corridor cannot be selected; API returns 409 |
| No fresh FX rate | `lib/fx/rates.ts` | Corridor closes; `/api/transfers/prepare` returns 503 |
| MockQUSD on mainnet | `script/Deploy.s.sol` | Deployment reverts |
| Multisig that is an EOA on mainnet | `script/Deploy.s.sol` | Deployment reverts |
| Unverified wallet sending | `KYCRegistry.checkAndConsume` | Transaction reverts with `KYCRequired` |
| Type errors | `next.config.ts` | Build fails |

---

## 1. Contracts — BLOCKING

The contracts currently deployed to QIE mainnet are wired to **MockQUSD**
(`0x9b5D…0827`), an owner-mintable token with no backing and no redemption path.
It is a fine test token and it cannot carry value. `QUSD` is immutable in both
`EscrowVault` and `RemitChain`, so pointing at the real stablecoin means a
**redeployment**. There is no way around this.

### 1.1 Decide the real token

Confirm with QIE which contract is the canonical, redeemable USD stablecoin on
chain 1990, and confirm it has 6 decimals. `contracts/.env.example` currently
suggests `0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5` — verify that on-chain
before trusting it.

### 1.2 Set up custody

- [ ] Deploy a **Gnosis Safe** on QIE mainnet. It becomes the timelock's
      proposer and executor. The deploy script rejects an EOA here.
- [ ] Provision a **dedicated passOracle key**, separate from the deployer.
- [ ] Provision a **relayer key**, separate from both — ideally in a KMS/HSM.

Three distinct keys. The deploy script rejects reuse on mainnet.

### 1.3 Deploy

```bash
cd contracts
cp .env.example .env    # fill in DEPLOYER_PRIVATE_KEY, MULTISIG_ADDRESS,
                        # PASS_ORACLE_ADDRESS, QUSD_ADDRESS, FEE_TREASURY_ADDRESS

forge test                                            # expect 127 passing
forge script script/Deploy.s.sol --rpc-url qie_mainnet          # dry run first
forge script script/Deploy.s.sol --rpc-url qie_mainnet --broadcast --verify
```

### 1.4 Accept ownership — BLOCKING

`Ownable2Step` leaves ownership *pending*. Until the Safe calls
`acceptOwnership()` on all three contracts, the deployer still controls them.

- [ ] `KYCRegistry.acceptOwnership()` from the Safe
- [ ] `EscrowVault.acceptOwnership()` from the Safe
- [ ] `RemitChain.acceptOwnership()` from the Safe
- [ ] Confirm `owner()` on each returns the TimelockController

### 1.5 Point the app at the new contracts

```bash
cd frontend
pnpm sync:abis          # updates lib/contracts.ts from contracts/deployments/
```

Verify the mainnet block in `lib/contracts.ts` matches
`contracts/deployments/qie_mainnet.json`, and update `DEPLOYMENT_BLOCKS` in
`lib/events/listener.ts` to the new deployment block — otherwise the event
listener replays from the old contract's history.

---

## 2. Payout provider — BLOCKING

**Nothing reaches a recipient's bank account without this.** Today only the
India/UPI corridor has an implementation.

### 2.1 RazorpayX

- [ ] RazorpayX account **activated** (this is separate from a Razorpay Payments
      account — activation requires business KYC and takes days, not hours)
- [ ] Note your **virtual account number** — the source of funds. This is
      `RAZORPAY_ACCOUNT_NUMBER`, not your bank account number.
- [ ] Generate **live** API keys (`rzp_live_…`)
- [ ] Register the webhook: `https://<your-domain>/api/webhooks/razorpay`
      - Events: `payout.processed`, `payout.failed`, `payout.reversed`,
        `payout.updated`, `payout.rejected`
      - Save the signing secret as `RAZORPAY_WEBHOOK_SECRET`
- [ ] **Fund the virtual account.** Payouts draw from it. `queue_if_low_balance`
      is deliberately `false`, so an underfunded account fails fast and retries
      rather than silently queueing.

### 2.2 The other four corridors

`us-mx` (SPEI), `gb-ng` (OPay), `sa-pk` (JazzCash) and `sg-bd` (bKash) have **no
provider**. They will not appear as selectable destinations, and the API rejects
them with 409. This is intentional — the previous build reported these payouts
as `COMPLETED` while sending nothing.

To open one: write a provider in `lib/payouts/providers/` implementing
`PayoutProvider`, add its id to that corridor's `providers` array in
`lib/corridors.ts`, and teach `isProviderConfigured` what credentials it needs.
Nothing else changes.

---

## 3. Compliance — BLOCKING for a public launch

This is a cross-border money transmission service. The code now enforces the
technical controls; the licensing is yours to obtain.

- [ ] **Money transmitter licensing / partnership** for each corridor you open.
      In practice most launches run under a licensed partner's umbrella rather
      than holding licences directly.
- [ ] **KYC provider** integrated. Until `KYC_PROVIDER` is set,
      `/api/kyc/upgrade` refuses to raise anyone's tier on mainnet, and tier 0
      has a **zero** daily limit — so no unverified wallet can send at all.
      Wire your provider's signed decision into `verifyProviderDecision` in
      `app/api/kyc/upgrade/route.ts`.
- [ ] **Sanctions / PEP screening** on both sender and recipient. There is no
      hook for this yet — add it in `/api/transfers/prepare`, before the FX quote.
- [ ] **Transaction monitoring and SAR filing** process.
- [ ] **Data retention and erasure policy.** The system already minimises what
      it stores: full phone numbers are never persisted (only a peppered
      commitment and a masked form), and claim secrets are wiped on settlement.
- [ ] **Customer support path.** Payouts in `MANUAL_REVIEW` need a human. Decide
      who watches that queue before you have one.

---

## 4. Infrastructure

- [ ] **Neon Postgres** provisioned; `DATABASE_URL` set
- [ ] **Upstash Redis** provisioned; `UPSTASH_REDIS_REST_URL` + token set.
      Without it, rate limits become per-instance, meaning N workers = N× every
      limit.
- [ ] **Email** configured (Resend preferred) and the sending domain verified.
      A claim code in a spam folder is a transfer that never completes.
- [ ] Generate the two permanent secrets and **back them up**:
      ```bash
      # SECRETS_ENCRYPTION_KEY
      node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
      # PHONE_HASH_PEPPER
      node -e "console.log('0x'+require('crypto').randomBytes(32).toString('hex'))"
      # CRON_SECRET
      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
      ```
      Losing `PHONE_HASH_PEPPER` strands every in-flight transfer. Treat both
      like a database encryption key.
- [ ] `NEXT_PUBLIC_APP_URL` set to the real origin
- [ ] Vercel plan supports the cron cadence in `vercel.json` — `/api/cron/payouts`
      runs every 2 minutes and is the reliability guarantee behind every payout.
      **Hobby plans only permit daily crons.** On Hobby, the payout worker
      effectively does not run.

---

## 5. Database migration

```bash
cd frontend
pnpm db:migrate
```

Migration `0001_production_hardening` is idempotent and safe to re-run. It:

- widens every timestamp column from `int4` to `int8` and rescales
  seconds-valued rows to milliseconds
- adds the `payouts` and `webhook_events` tables
- lifts historical `offramp_*` columns into the payout ledger as
  `MANUAL_REVIEW` — the old code marked stubbed corridors `COMPLETED` without
  moving money, so their true state is unknown and needs a human
- converts permanent OTP locks into time-boxed ones and releases anyone
  currently stuck

**Take a snapshot first.** It drops columns after backfilling them.

---

## 6. Cutover

The OTP and phone-hash schemes both changed. Transfers created before the
upgrade were committed under the old scheme and cannot verify under the new one.

1. Deploy with `ALLOW_LEGACY_OTP_SCHEME=true`. Both schemes are accepted, so
   in-flight transfers stay claimable. The app logs a warning on every boot.
2. Wait **48 hours** — the full claim window. Every pre-upgrade transfer has
   either been claimed or expired by then.
3. Redeploy with the flag removed.

Confirm step 3 actually happened. While it is set, the old brute-forceable
commitment is still accepted for any transfer that presents one.

---

## 7. Pre-flight verification

```bash
curl -s https://<your-domain>/api/health | jq
```

Expect `"status": "ok"` and HTTP 200. Anything else returns **503** and names
what is wrong. Check specifically:

- `services.*` — every entry configured, none reading `MISSING`
- `summary.corridorsLive` — at least 1
- `corridors[].live` — `true` for every corridor you intend to open. A corridor
  showing `live: false` is a simulated rail.

Then run one real transfer end to end, with your own money, at the minimum
amount:

- [ ] Send 1 QUSD on the UPI corridor to a UPI ID you control
- [ ] Confirm the claim email arrives, and that the link contains a `#s=…` fragment
- [ ] Claim it; confirm the on-chain `claimRemittance` succeeds
- [ ] Confirm the payout row reaches `PAID` (check `/api/transfers/<id>`)
- [ ] **Confirm the rupees actually arrive in the destination account**
- [ ] Confirm the amount matches the quote the sender was shown
- [ ] Confirm the payout is the NET amount (gross minus the 0.1% fee)
- [ ] Spot-check the quoted rate against a public source. `/api/corridors`
      returns `rate`, `rateSource` and `rateAgeMs` for every corridor.

The last three are the ones that matter. Everything before them can pass while
money still fails to land.

---

## 8. Monitoring

Structured JSON logs go to the Vercel log drain. Alert on:

| Log step | Meaning | Urgency |
|---|---|---|
| `payout.orphaned_claim` | Escrow released, no payout row. A recipient is owed money and we lack their payout details. | **Page someone** |
| `payout.attempt_failed` with `ambiguous: true` | We cannot tell whether money moved. Never auto-retried. | **Page someone** |
| `claim.relayer_out_of_gas` | Relayer is dry; all claims are failing. | **Page someone** |
| `payout.illegal_transition` | A state machine violation — indicates a bug. | High |
| `webhook.unknown_payout` | Razorpay knows a payout we do not. | High |
| `claim.settlement_record_failed` | Escrow released but bookkeeping failed. | High |
| `otp_guard.locked` | Repeated failures on one transfer. Spikes suggest an attack. | Medium |

Also watch:
- Payouts in `MANUAL_REVIEW` — this queue must not grow unattended
- Relayer native balance
- RazorpayX virtual account balance
- `TransferClaimed` rate versus baseline (relayer key compromise signal)

---

## 9. Known residual risks

Accept these deliberately, or address them before launch.

1. **The relayer is a custodian.** It is the on-chain `recipient` and signs its
   own authorization, so its key can release any claimable escrow. Inherent to a
   wallet-less recipient model. Mitigate with KMS custody, a gas-only balance,
   and rate alerting. See `contracts/THREAT_MODEL.md` §5.1.
2. **Escrow release and fiat payout are not atomic.** No system spanning a
   blockchain and a payment provider can be. The failure is one-sided by design:
   a claim with no payout is detectable and repairable; a payout with no claim
   is impossible.
3. **FX exposure.** The rate is locked at send time and honoured at claim, up to
   48 hours later. You carry the movement in between. At volume, hedge it or
   add a spread.

   Rates come from two independent free sources (`open.er-api.com`, then
   `currency-api` on jsDelivr) with failover, a Redis cache, and a sanity check
   that rejects a feed whose median move against the last known rates exceeds
   25%. There are no hard-coded fallback rates — when no rate is available
   within `FX_MAX_STALENESS_MINUTES` (default 60), the corridor closes and sends
   are refused.

   **Before launch, consider a paid FX feed with an SLA.** Both current sources
   are free and unsupported; if both are down for more than an hour, sending
   stops. That is the correct failure (refusing beats paying the wrong amount),
   but it is still downtime.
4. **A stale `MANUAL_REVIEW` queue is a customer-service failure**, not a
   technical one. It needs an owner.
5. **Single relayer.** No failover. If it goes down, claims stop. Senders can
   still self-refund after 48h.

---

## 10. Rollback

If something goes wrong after launch:

1. **Stop new sends** — `RemitChain.pause()` via the timelock. Note this takes
   **2 days** through the timelock, so for anything urgent, take the frontend
   down instead: it is the only route to `sendRemittance`.
2. **Claims and refunds keep working.** `cancelRemittance` is deliberately not
   pausable, so senders can always recover funds.
3. **Stop payouts** — remove `RAZORPAY_KEY_ID`. The corridor closes and payouts
   queue in `CREATED` rather than being lost.
4. **Drain the queue** once resolved: payouts resume from the ledger on the next
   cron tick. Nothing is lost, because nothing was held only in memory.
