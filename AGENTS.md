# AGENTS.md — RemitChain

Operating manual for AI coding agents working in this repo. Read this fully before editing. If a rule here conflicts with a request, follow this file and flag the conflict.

Project: It's a PWA (Progressive Web App) — and that's a deliberate, strategic choice, not a compromise. Phone-number-only **general payments & cross-border remittance** app on QIE blockchain. Pay anyone by phone number, for near-zero fees (0.1%), with zero crypto knowledge required. QUSD escrow + OTP claim. Cross-border remittances are the hero use case, but the engine powers daily P2P, merchant, and domestic payments too. Stack: **Foundry** (contracts) + **Next.js 14** (web/api). Full architecture in `CLAUDE.md`.

---

## Golden rules

1. **Money code is sacred.** Any change to `contracts/src/*.sol` requires matching tests in the same PR. Never weaken a security check to make a test pass.
2. **Never put secrets in client code.** The relayer/deployer private key lives in server env only. If you see a key heading toward `NEXT_PUBLIC_*` or a client component, stop.
3. **The relayer is the crown jewels.** It holds funds and calls `claimRemittance()` for users. Treat `app/api/relayer/route.ts` as a high-security surface — validate, rate-limit, make idempotent.
4. **Don't invent QIE APIs.** If a QIE Pass / Wallet / Oracle / QIEDex method isn't confirmed, leave a `// TODO(qie):` stub and a typed interface — don't fabricate endpoints.
5. **Ask before destructive ops.** No `forge clean`-and-redeploy, no DB resets, no force-push, no editing `deployments.json` by hand.

---

## Setup

```bash
# contracts
cd contracts && forge install && forge build

# web
cd web && pnpm install && pnpm dev
```

Requires: Foundry (forge/cast/anvil), Node 20+, pnpm. Copy `.env.example` → `.env` (never commit `.env`).

---

## Commands the agent should use

| Task | Command |
|---|---|
| Build contracts | `forge build` |
| Test (verbose) | `forge test -vvv` |
| Coverage | `forge coverage` |
| Format | `forge fmt` |
| Static analysis | `slither .` |
| Gas snapshot | `forge snapshot` |
| Local chain | `anvil` |
| Deploy | `forge script script/Deploy.s.sol --rpc-url qie_testnet --broadcast --verify` |
| Web dev | `pnpm dev` |
| Web build | `pnpm build` |
| Lint/type | `pnpm lint && pnpm tsc --noEmit` |

**Before declaring any task done, run:** `forge test` + `forge fmt --check` (contracts) or `pnpm lint && pnpm tsc --noEmit && pnpm build` (web). Don't claim success on red.

---

## Contract conventions (Foundry / Solidity)

- Solidity `^0.8.24`. Use OpenZeppelin — don't hand-roll `ReentrancyGuard`, `Ownable`, `Pausable`, `SafeERC20`.
- **CEI pattern** (checks-effects-interactions) on every fund-moving function. Reentrancy guard on all of them.
- Custom errors, not `require("string")`. Example: `error TransferExpired();`
- No floats. QUSD has 6 decimals; store integer base units only.
- Emit an event on every state change. Frontend depends on these.
- Tests live in `test/*.t.sol`. Every public/external fn needs unit tests **plus** fuzz tests for amount/time inputs **plus** invariant tests for escrow balance (vault balance == sum of PENDING transfers).
- Naming: `test_RevertWhen_...`, `testFuzz_...`, `invariant_...`.
- Run `forge fmt` before commit. Keep functions small and single-purpose.

## Web conventions (Next.js)

- App Router, TypeScript strict, Server Components by default. `"use client"` only when needed (wallet hooks, interactivity).
- Chain access via **viem + wagmi**. Reads in Server Components / route handlers; writes via wagmi hooks client-side (except relayer-driven claims).
- Contract ABIs + addresses imported from `lib/contracts.ts` (generated from Foundry artifacts — don't paste ABIs inline).
- Server-only secrets: import from `lib/env.server.ts`, never expose. Public config uses `NEXT_PUBLIC_*`.
- Validate all API inputs with zod. Phone numbers normalized to E.164.
- Tailwind for styling. No UI library unless asked.
- Never use `localStorage` for funds/keys/PII.

---

## Critical invariants — never break

- Escrow can only release to the intended recipient or refund the original sender. No third path.
- OTP is hashed (keccak256), single-use, and expires with the transfer.
- A claim must be **idempotent** — retrying the same `claimRemittance` must never double-pay.
- Transfers auto-expire at 48h; expired transfers refund only the sender.
- Daily KYC limits enforced on-chain in `KYCRegistry`, not just in UI.
- Sender never sees "QUSD"; recipient never signs a transaction.

---

## Definition of done

A change is done only when:
- [ ] Tests written/updated and `forge test` green (or `pnpm build` + types green for web)
- [ ] `forge fmt` / `pnpm lint` clean, slither shows no new findings
- [ ] No secrets client-side; no fabricated QIE APIs
- [ ] Events emitted for new state changes; ABIs regenerated if contract changed
- [ ] Short summary of what changed + why, and anything left as `TODO`

---

## PR / commit style

- Conventional commits: `feat:`, `fix:`, `test:`, `refactor:`, `chore:`, `sec:`.
- One logical change per PR. Contract + its tests ship together.
- PR body: what changed, why, how tested, any new env vars or migration steps.

---

## When stuck

- Missing QIE SDK detail → stub with typed interface + `// TODO(qie):`, keep building.
- Ambiguous money/security behavior → stop and ask; don't guess.
- Don't add dependencies for trivial things; prefer stdlib / viem / OZ.
- If a request would break a Critical Invariant above, refuse and explain.
