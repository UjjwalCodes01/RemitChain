# CLAUDE.md — RemitChain

> PayPal / Venmo / UPI — but on QIE rails with near-zero fees.
> Pay anyone, anywhere, by phone number. No crypto knowledge required.
> Stack: **Foundry** (contracts) + **Next.js** (frontend).

---

## What it is

RemitChain is a **general-purpose payments app** built on QIE blockchain. It's a PWA (Progressive Web App) — and that's a deliberate, strategic choice, not a compromise.

Sender enters a phone number → QUSD locked in on-chain escrow → recipient claims with a 6-digit OTP via SMS → cash out via local rail (UPI, GCash, bKash, SPEI…). Neither side needs a wallet or crypto knowledge.

The same core engine powers:
- **Cross-border remittances** — the hero use case; workers saving 4.4% vs Western Union
- **Daily P2P payments** — split a bill, pay back a friend, send rent
- **Merchant payments** — pay a shop, a freelancer, a service
- **Domestic transfers** — send to family anywhere, same country or abroad

**Hackathon:** QIE Blockchain 2026 · DeFi & Payments · Build May 16–Jun 14 · Submit Jun 15–19 · Prize $20.5K + $1M grant track · Bonus for 100+ active users.

---

## Why it wins

- $860B remittance market + $trillions in daily P2P payments — one product addresses both.
- Beats UN SDG 10.c target (3% by 2030) — already at 0.1%.
- Uses all 5 QIE components. Zero-crypto UX. Real on-chain users, not a demo.
- **Sharp edges:** phone-number routing (not wallet address), OTP claim (no wallet needed for recipient), 0.1% fee (vs 2-7% everywhere else), cross-border by default.

---

## Corridors (launch)

| Sender → Recipient | Legacy fee | Payout rail |
|---|---|---|
| UAE → Philippines | 4.2% | GCash / InstaPay |
| USA → Mexico | 3.1% | SPEI / Oxxo |
| Gulf → India | 3.8% | UPI / IMPS |
| UK → Nigeria | 5.8% | Opay / GTBank |
| Saudi → Pakistan | 4.9% | Easypaisa / JazzCash |
| Singapore → Bangladesh | 5.1% | bKash / Nagad |

Demo India end-to-end; others as configurable "coming soon".

---

## QIE integration

| Component | Role |
|---|---|
| QIE Pass | KYC + identity (sender & recipient) |
| QIE Wallet | Sender signs `approve()` + `sendRemittance()` |
| QUSD stablecoin | Transfer currency (1 QUSD = $1) |
| QIEDex | Fiat ↔ QUSD on/off-ramp |
| QIE Oracle | Live FX rates |

Chain ID `1983` · RPC `https://rpc1testnet.qie.digital/`

---

## Contracts (Foundry, `src/`)

**RemitChain.sol** — router
`sendRemittance(recipientPhoneHash, amount, corridor)` · `claimRemittance(transferId, otpHash)` · `cancelRemittance(transferId)` · `getTransferStatus(transferId)`

**EscrowVault.sol** — custody
`lockFunds(transferId, amount)` · `releaseFunds(transferId, recipient)` (−0.1% fee) · `refundFunds(transferId)` · states PENDING→CLAIMED|CANCELLED · 48h auto-expiry

**KYCRegistry.sol** — identity
`verifyUser(addr, qiePassId)` · `getKYCLevel(addr)` (0/1/2) · `getDailyLimit(addr)` (T1 $500, T2 $5k) · `checkDailyUsage()` resets midnight UTC

**Production rules:** OZ `ReentrancyGuard` + `Ownable` on all fund moves · CEI pattern · no floats (6-decimal QUSD units) · `SafeERC20` for transfers · custom errors not `require` strings · events on every state change · `Pausable` kill-switch.

---

## Flow (6 steps)

1. On-ramp — sender buys QUSD via QIEDex in local currency
2. Initiate — enter recipient phone + amount; show live FX + fee
3. Escrow — `approve()` + `sendRemittance()` locks QUSD
4. Notify — backend hears `TransferInitiated` → SMS in recipient's language (<3s)
5. Claim — recipient enters phone + OTP → **relayer** calls `claimRemittance()`
6. Off-ramp — QUSD → UPI/GCash/bKash push, or QR cash agent

---

## UX rules

- Recipient: phone + OTP only, never signs a tx (relayer does it).
- Sender never sees "QUSD" — only local currency.
- SMS auto-localized by phone prefix; Android Web OTP API auto-fills code.
- Success screen → "Add to home screen" (PWA) converts recipient to repeat user.

---

## Stack

**Contracts:** Foundry (forge/cast/anvil), Solidity ^0.8.24, OpenZeppelin, `forge-std`.
**Frontend:** Next.js 14 (App Router), TypeScript, wagmi + viem, TanStack Query, Tailwind, PWA (next-pwa).
**Backend:** Next.js API routes / route handlers — relayer + event listener (viem `watchContractEvent`), Twilio SMS, off-ramp APIs.
**Infra:** Vercel (frontend + API) · relayer key in env, never client-side.

---

## Repo structure

```
remitchain/
├── contracts/                 # Foundry root
│   ├── src/{RemitChain,EscrowVault,KYCRegistry}.sol
│   ├── test/*.t.sol           # forge tests + fuzz + invariants
│   ├── script/Deploy.s.sol
│   └── foundry.toml
└── web/                       # Next.js root
    ├── app/
    │   ├── (sender)/send/page.tsx
    │   ├── claim/[txId]/page.tsx     # recipient claim (no wallet)
    │   ├── dashboard/page.tsx        # judge metrics
    │   └── api/
    │       ├── relayer/route.ts      # OTP → claimRemittance()
    │       ├── notify/route.ts       # event → Twilio SMS
    │       └── offramp/route.ts      # QUSD → UPI/GCash
    ├── lib/{wagmi,contracts,oracle}.ts
    ├── hooks/{useSend,useQIEPass,useFxRate}.ts
    └── public/manifest.json
```

---

## Production checklist

**Contracts**
- [ ] 100% test coverage (`forge coverage`) — unit + fuzz + invariant tests
- [ ] `forge fmt` + slither static analysis clean
- [ ] Reentrancy, access-control, overflow, expiry edge cases tested
- [ ] Deploy script idempotent; addresses logged to `deployments.json`
- [ ] Verify on QIE explorer (`forge verify-contract`)
- [ ] Pausable + owner = multisig before mainnet

**Frontend / backend**
- [ ] Relayer key in server env only; rate-limit `/api/relayer`
- [ ] OTP hashed (keccak256), single-use, expires with transfer
- [ ] Idempotent claim (no double-spend on retry)
- [ ] Event listener with reconnect + replay from last block
- [ ] Inputs validated server-side; phone numbers E.164
- [ ] Sentry error tracking; structured logs on relayer
- [ ] PWA installable, offline shell, Lighthouse >90

---

## Commands

```bash
# Contracts
forge build
forge test -vvv
forge coverage
forge script script/Deploy.s.sol --rpc-url qie_testnet --broadcast --verify

# Frontend
cd web && pnpm dev
pnpm build && pnpm start
```

`foundry.toml`
```toml
[rpc_endpoints]
qie_testnet = "https://rpc1testnet.qie.digital/"
[etherscan]
qie_testnet = { key = "${QIE_EXPLORER_KEY}", url = "..." }
```

`.env` (server only)
```
PRIVATE_KEY=            # deployer + relayer
QIE_PASS_API_KEY=
TWILIO_SID= TWILIO_AUTH_TOKEN= TWILIO_FROM=
UPI_API_KEY= GCASH_API_KEY=
NEXT_PUBLIC_CHAIN_ID=1983
NEXT_PUBLIC_RPC_URL=https://rpc1testnet.qie.digital/
```

---

## 30-day plan

| Wk | Focus | Done when |
|---|---|---|
| 1 | Foundry contracts + full test suite, testnet deploy, wagmi connect | contracts verified on testnet |
| 2 | send→escrow→claim e2e, relayer, SMS, Oracle FX | happy path works e2e |
| 3 | Next.js UX polish, QR claim, employer batch CSV send | batch + QR claim work |
| 4 | slither/audit pass, mainnet deploy, 100+ users, judge dashboard | submission ready |

---

## 100+ users

With general payments positioning, **anyone** is a valid user — not just migrant workers.

| Channel | Users | Lever |
|---|---|---|
| College peers / friends | 30–40 | split lunch, chai, events — live demo in class |
| WhatsApp groups | 30 | 30s live-transfer video — "pay me back by phone number" |
| Employer batch send | 20–30 | one factory HR = one CSV upload |
| Live demo event | 25 | send real QUSD on stage, audience claims it |
| NGO / community partner | 20 | one coordinator's caseload |
| Referrals | 15 | refer 3 → free transfer |

**Active user = wallet connected + ≥1 on-chain tx.** (Broad payments = lower acquisition friction.)
