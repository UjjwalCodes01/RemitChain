# Running RemitChain end to end, locally

How to bring up the entire stack — contracts, database, application — on your
own machine, and prove the money path works before it touches a real network.

Everything here uses real components. The chain is a real EVM node, the database
is real Postgres, the application is the real production build. Only the payout
rail is simulated, and it is labelled as such everywhere it appears.

---

## Prerequisites

- Foundry (`anvil`, `forge`, `cast`)
- Node 22, pnpm
- PostgreSQL running locally

---

## 1. Chain

```bash
anvil --port 8545 --chain-id 31337
```

Leave it running. In another terminal:

```bash
cd contracts

DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
PASS_ORACLE_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
FEE_TREASURY_ADDRESS=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 \
forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

Those are anvil's standard accounts — deployer #0, oracle #1, treasury #4. They
are published in Foundry's documentation and hold no value.

`DeployLocal.s.sol` refuses to run on any chain other than 31337. It skips the
TimelockController and uses `MockQUSD`, both of which `Deploy.s.sol` forbids on
mainnet.

## 2. Wire the app to the local deployment

```bash
cd ../frontend
pnpm install
pnpm sync:abis
```

`sync:abis` reads `contracts/deployments/anvil.json` and writes the addresses
into `lib/contracts.ts`. Re-run it after every redeploy — otherwise the app
talks to the previous deployment.

## 3. Database

```bash
createdb remitchain_local
export DATABASE_URL="postgresql://$USER:yourpassword@localhost:5432/remitchain_local"
pnpm db:migrate
```

`lib/db/index.ts` picks the driver from the connection string: Neon's HTTP
driver for `*.neon.tech`, plain `pg` for anything else. No code change needed.

## 4. Environment

```bash
cat > .env.e2e <<'EOF'
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545
NEXT_PUBLIC_APP_URL=http://localhost:3100
NEXT_PUBLIC_RELAYER_ADDRESS=0x90F79bf6EB2c4f870365E785982E1f101E93b906
RELAYER_PRIVATE_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/remitchain_local
SECRETS_ENCRYPTION_KEY=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=
PHONE_HASH_PEPPER=0x1111111111111111111111111111111111111111111111111111111111111111
CRON_SECRET=e2e-cron-secret-value-1234567890
ENABLE_SANDBOX_PAYOUTS=true
OTP_CHANNEL=email
EOF
```

`ENABLE_SANDBOX_PAYOUTS` turns on the simulated payout rail so the ledger,
worker, reconciler and UI can all be exercised without a provider account. It is
**refused at boot on a production chain** — the app will not start.

`.env*` is gitignored apart from `.env.example`, so this file stays local.

## 5. Run

```bash
set -a && . ./.env.e2e && set +a
pnpm build && pnpm start -p 3100
```

Check it came up:

```bash
curl -s http://localhost:3100/api/health | jq
```

You will see `"status": "unavailable"` with
`notifications: "MISSING — recipients cannot receive claim codes"`. That is
correct: no email provider is configured. The health endpoint refuses to call
the service healthy when a recipient could not be told they have money waiting.
The flow still works locally — off a production chain the email step logs
`[EMAIL-STUB]` with the claim URL instead of sending.

---

## 6. Verify

Two suites. Both drive real transactions against the deployed contracts.

### `pnpm e2e:http` — the full stack

Everything over HTTP against the running server. 61 assertions covering:

| Step | What is proven |
|---|---|
| `/api/corridors` | rates are live, closed corridors reported honestly, simulated rails flagged `live: false` |
| `/api/transfers/prepare` | server mints the credentials, normalises a national phone number, quotes on the NET amount, and leaks no OTP in its response |
| approve + `sendRemittance` | the wallet's transaction is accepted and the vault takes custody |
| `/api/transfers/confirm` | receipt verified, expiry stored in ms, full phone number never persisted, fee split recorded |
| credentials | OTP and claim secret are encrypted at rest and decrypt correctly |
| wrong OTP / wrong phone | both rejected with the *same* message, and the escrow stays locked |
| `/api/relayer/claim` | escrow releases; recipient gets the net, treasury gets exactly the 0.1% fee |
| payout ledger | one row, priced from the locked quote, destination masked, intent recorded pre-broadcast |
| replay | a second claim is idempotent and creates no second payout |
| `/api/cron/payouts` | authenticated, reconciles the payout to `PAID` with a bank reference; rejects unauthenticated calls |
| public reads | no OTP, secret or full destination in any response |
| removed routes | the five deleted endpoints all 404 |
| webhook | an unsigned webhook is rejected |

### `pnpm e2e:local` — contracts and cryptography

28 assertions against the contracts directly, using the same `lib/` modules the
server uses. This is the suite that catches the failure nothing else can: a
derivation that is self-consistent in TypeScript but does not reproduce the
commitment the deployed Solidity actually checks.

It also asserts the negatives — that a wrong OTP reverts with
`InvalidOTPReveal`, that the legacy low-entropy scheme cannot open a modern
commitment, that a claimed transfer cannot be claimed twice, and that
`cancelRemittance` refunds the full amount with no fee taken.

Note `e2e:local` needs the `react-server` export condition, because
`lib/relayer/claim.ts` is marked `server-only`:

```bash
NODE_OPTIONS='--conditions=react-server' pnpm e2e:local
```

Both scripts derive a **fresh sender account** on every run. A fixed account
keeps its KYC tier and consumes its daily allowance, so a second run would fail
with `DailyLimitExceeded` through no fault of the code.

---

## Things you will hit

**`claim.ip_rate_limited` after a few runs.** The claim endpoint allows 10
attempts per IP per hour and every run makes four. Without Redis the limiter is
in-process, so restarting the server resets it. This is the limiter working.

**Corridors show `open: false`.** Either no payout provider is configured
(`ENABLE_SANDBOX_PAYOUTS` unset) or no live FX rate is available. Both are
deliberate: the app refuses to quote a transfer it cannot price or pay.

**`DailyLimitExceeded`.** Tier 1 allows 500 QUSD per day. Raise the sender to
tier 2 with an oracle attestation, or use a fresh account.

**Stale addresses after a redeploy.** Re-run `pnpm sync:abis`.

---

## Everything at once

```bash
pnpm test          # 104 unit tests
pnpm e2e:local     # 28 contract + crypto assertions   (needs anvil)
pnpm e2e:http      # 61 full-stack assertions          (needs anvil + db + server)
cd ../contracts && forge test    # 127 contract tests
```
