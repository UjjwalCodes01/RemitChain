# RemitChain Threat Model

**Version:** 1.0  
**Scope:** `KYCRegistry.sol`, `EscrowVault.sol`, `RemitChain.sol`  
**Date:** 2026-05-27  
**Classification:** Pre-audit security analysis

---

## 1. System Overview

RemitChain is a phone-number-only cross-border remittance protocol on QIE Chain. Users lock QUSD stablecoin into an escrow vault and recipients claim funds using a one-time password (OTP) delivered out-of-band by the relayer. The protocol is designed so that:

- **Senders never custody funds** — QUSD moves atomically from sender to escrow.
- **Recipients never sign transactions** — the relayer calls `claimRemittance` on their behalf, but must present the recipient's EIP-712 signature.
- **The relayer cannot redirect funds** — OTP commit-reveal is bound to the specific recipient address.
- **Funds are always recoverable** — pause/emergency mechanisms exempt refund paths.

---

## 2. Trust Assumptions

| Actor | Trust Level | Notes |
|---|---|---|
| Deployer | High (initial) | Replaced by TimelockController post-deploy |
| TimelockController (multisig) | High | 2-day delay, Gnosis Safe proposer/executor |
| PassOracle | Medium-High | External QIE Pass signer; must not be compromised |
| Relayer | Medium | May be a bot; cannot steal funds even if compromised |
| Sender | Low | Authenticated by KYC + EVM address |
| Recipient | Untrusted | Not required to interact with the chain |

---

## 3. Attack Surface Analysis

### 3.1 `KYCRegistry.sol`

| # | Threat | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| K1 | **Forged oracle signature** — attacker submits fabricated KYC attestation | Bypass daily limits, spam protocol | Low (requires key compromise) | EIP-712 + nonce prevents replays; invalid sigs revert with `InvalidSignature` |
| K2 | **Signature replay across chains** — valid sig from mainnet reused on testnet | Bypass KYC on lower-security chain | Low | `domainSeparator` includes `chainId`; replays produce wrong digest |
| K3 | **Nonce skip attack** — attacker forces nonce to skip, making oracle certs unusable | DoS on user KYC | Not applicable | Nonces increment sequentially, not caller-controlled |
| K4 | **Admin sets 0 daily limit** — griefs all users | Denial of service | Low | Owner is a TimelockController with 2-day delay; community can react |
| K5 | **passOracle key compromise** — attacker verifies anyone at any tier | Full KYC bypass | Critical (external) | TimelockController rotation with 2-day delay; oracle is external QIE Pass system |
| K6 | **checkAndConsume caller spoofing** — non-RemitChain address tries to consume limit | Bypass daily limit | Low | `CallerNotRemitChain` guard; `remitChain` is `immutable` |

**Residual risk:** `passOracle` compromise is the highest-impact scenario. Mitigation: `setPassOracle` requires a 2-day timelock operation, giving users time to withdraw. A compromised oracle cannot steal funds — it can only grant KYC, not authorize claims.

---

### 3.2 `EscrowVault.sol`

| # | Threat | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| E1 | **Reentrancy on releaseFunds/refundFunds** | Double-spend, drain vault | Low | `nonReentrant` on all fund-moving functions; CEI pattern enforced |
| E2 | **QUSD token is evil** — malicious ERC20 re-enters on `transfer` | Drain vault | Low (QUSD is a known stablecoin) | `nonReentrant` + `SafeERC20` + CEI eliminates this regardless |
| E3 | **Admin pauses vault trapping user funds** | User funds locked permanently | Low | `refundFunds` is NOT gated by `whenNotPaused`; users can always recover |
| E4 | **Fee overflow** — fee calculation overflows, wrong distribution | Recipient underpaid, protocol overcharged | Very low | Solidity 0.8.24 checked arithmetic; `feeBps <= 100` hard cap |
| E5 | **transferId collision** — two different transfers hash to the same ID | Fund confusion, potential theft | Negligible | 256-bit keccak with sender + nonce + chainId + contract address |
| E6 | **Fee treasury set to address(0)** — fee transfer to zero | Fee loss, potential QUSD burn | Low | `setFeeTreasury(address(0))` reverts with `ZeroAddress` |
| E7 | **Vault solvency violation** — `totalLocked` > actual QUSD balance | Users cannot be refunded | Negligible | Invariant tested: `balanceOf(vault) >= totalLocked` always holds |

**Critical invariant tested in `EscrowInvariants.t.sol`:**
```
invariant: qusd.balanceOf(vault) >= vault.totalLocked()
```

---

### 3.3 `RemitChain.sol`

| # | Threat | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | **Relayer redirection** — relayer submits claim with wrong `recipient` address | Funds go to attacker | Medium (relayer is semi-trusted) | OTP commit-reveal: `keccak(otpReveal, transferId, recipient)` — wrong recipient invalidates the OTP |
| R2 | **Front-running OTP** — MEV bot sees OTP in mempool and claims first | Attacker receives funds | Medium (public mempool) | Recipient EIP-712 signature is also required; MEV bot cannot forge it |
| R3 | **Signature replay** — valid claim sig reused for different transfer | Double-claim | Low | EIP-712 includes `transferId` + `nonce`; nonce increments on each claim |
| R4 | **Expired transfer claimed** — transfer past 48h claimed | Stale claim, possible double-refund | Low | `block.timestamp >= t.expiry` checked strictly before any state change |
| R5 | **Admin pause traps funds** | Funds frozen indefinitely | Low | `cancelRemittance` is NOT `whenNotPaused`; users always retain refund path |
| R6 | **Idempotency — double-claim** | Double payment to recipient | Low | Status set to `CLAIMED` before external call (CEI); second call reverts on `TransferNotPending` |
| R7 | **OTP brute-force** | Attacker guesses 6-digit PIN | Medium (if PIN space is small) | OTP is 32 bytes on-chain (not 6-digit); full 32-byte preimage entropy |
| R8 | **Permit front-running** — attacker front-runs `sendRemittanceWithPermit` | Griefs user's permit (cannot prevent) | Low | Only griefs that specific send; does not compromise funds; user can re-send with regular approve |
| R9 | **Cross-chain replay** — signed claim valid on both testnet and mainnet | Unauthorized claim on secondary chain | Low | `domainSeparator` includes `chainId` |
| R10 | **Nonce manipulation by sender** | Denial of service on sender | Not applicable | Nonces are per-sender, monotonic, not caller-settable |

---

## 4. Economic Attacks

| # | Threat | Mitigation |
|---|---|---|
| EC1 | **Fee extraction via inflate-and-claim** — deposit max tier, extract fee, repeat | Fee is capped at `MAX_FEE_BPS = 100` (1%); daily limits bound max throughput |
| EC2 | **Dust spam** — many tiny transfers to bloat storage | `MIN_AMOUNT` prevents sub-threshold spam |
| EC3 | **Gas griefing on relayer** — recipient refuses to sign, trapping relayer's gas | Sender can cancel and refund after 48h; relayer loses only gas |
| EC4 | **Oracle price manipulation (QIEDex)** | FX rate is informational only; no on-chain price oracle gates fund release |

---

## 5. Admin Key Compromise

**Scenario:** MultisigOwner is compromised.

**Impact without TimelockController:**
- Could pause all contracts indefinitely
- Could change passOracle to a rogue oracle
- Could change fee treasury to drain fees
- Cannot steal user funds (pause-exempt refund path)

**Impact with TimelockController (2-day delay, as deployed):**
- All above actions take ≥ 2 days
- Community / monitoring services detect and cancel malicious proposals
- Users have 48h window to cancel pending transfers and reclaim funds

**Residual risk:** A compromised multisig with 2-day timelock cannot steal existing user funds before they expire and self-cancel. This is the designed safety model.

---

## 6. Invariants

These must hold at all times, and are enforced by `EscrowInvariants.t.sol`:

| Invariant | Description | Test |
|---|---|---|
| **Solvency** | `vault.qusd.balance >= vault.totalLocked` | `invariant_VaultSolvency` |
| **No double-spend** | A CLAIMED transfer cannot be claimed again | `invariant_NoDoubleSpend` |
| **State machine** | Transitions: `NONE→PENDING→{CLAIMED,CANCELLED}` only | Status checks in all functions |
| **Refund safety** | `cancelRemittance` succeeds even when both contracts are paused | `test_Cancel_Succeeds_WhenPaused`, `test_PauseMidTransfer_RefundSucceeds` |
| **Escrow integrity** | Only `releaseFunds` (to recipient) or `refundFunds` (to sender) exit the vault | No third path; `releaseFunds`/`refundFunds` only callable by `remitChain` (immutable) |
| **OTP binding** | `claimRemittance` with wrong recipient always fails even with correct OTP | `test_RevertWhen_Claim_RelayerRedirectsToWrongRecipient` |

---

## 7. Out of Scope / Known Limitations

1. **QIE Pass oracle liveness** — if `passOracle` goes offline, new users cannot onboard. Existing users unaffected.
2. **Relayer liveness** — if the relayer goes offline, senders can cancel after 48h to self-refund. Recipients cannot claim without the relayer submitting the transaction.
3. **QUSD depeg** — protocol does not price-check QUSD. If QUSD depegs, users bear the economic risk.
4. **Phone number privacy** — `recipientPhoneHash` is a hashed phone number. The hash function (off-chain `keccak(salt, phone)`) provides weak privacy — a brute-force search over known phone number formats could de-anonymize recipients.
5. **No upgradability** — contracts are non-upgradeable by design. Bug fixes require redeployment + user migration.

---

## 8. Recommendations for Audit

1. **Verify CEI on all fund paths** in `EscrowVault` — `lockFunds`, `releaseFunds`, `refundFunds`.
2. **Validate `via-ir` compilation** does not introduce unexpected inlining that bypasses `nonReentrant`.
3. **Check that `Status.NONE` correctly represents "transfer does not exist"** — confirm that a default-zero `Transfer` struct cannot be manipulated to pass the `status != PENDING` check.
4. **Fuzz the EIP-712 domain separator** across different chain IDs to confirm no collision.
5. **Static analysis (Slither)** should be run with `--detect-all`; known false positives from OpenZeppelin's `_hashTypedDataV4` should be filtered.
6. **Consider a `maxTransferAmount` cap** per-transfer in addition to the daily limit to reduce single-transaction risk exposure.
