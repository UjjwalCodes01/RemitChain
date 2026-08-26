# RemitChain Threat Model

**Version:** 2.0  
**Scope:** `KYCRegistry.sol`, `EscrowVault.sol`, `RemitChain.sol`, and the off-chain relayer and payout pipeline  
**Date:** 2026-08-26  
**Classification:** Pre-audit security analysis

> **v2.0 revision note.** Version 1.0 described the contracts in isolation and
> claimed several properties the deployed *system* did not have. Three of its
> statements were wrong against the shipped implementation and are corrected
> here: R7 (OTP entropy), R1/R2 (relayer redirection), and §7.4 (phone privacy).
> Anyone reading v1.0 would have concluded the OTP was unguessable and that a
> compromised relayer could not move funds. Neither was true.

---

## 1. System Overview

RemitChain is a phone-number-only cross-border remittance protocol on QIE Chain. Users lock QUSD stablecoin into an escrow vault and recipients claim funds using a one-time password (OTP) delivered out-of-band by the relayer. The protocol is designed so that:

- **Senders never custody funds** — QUSD moves atomically from sender to escrow.
- **Recipients never sign transactions** — the relayer calls `claimRemittance` on their behalf.
- **Funds are always recoverable** — pause/emergency mechanisms exempt refund paths.

**The relayer IS the on-chain recipient.** The contract supports a two-key model
(OTP commit-reveal *plus* an EIP-712 signature from the `recipient` address),
but this product's entire premise is that the recipient has no wallet. The
relayer therefore passes its own address as `recipient` and signs for itself, so
the two keys collapse into one. The relayer is a **custodian**, not a
message-passer, and must be treated as such — see §3.3 R1/R2 and §5.

---

## 2. Trust Assumptions

| Actor | Trust Level | Notes |
|---|---|---|
| Deployer | High (initial) | Replaced by TimelockController post-deploy |
| TimelockController (multisig) | High | 2-day delay, Gnosis Safe proposer/executor |
| PassOracle | Medium-High | External QIE Pass signer; must not be compromised |
| Relayer | **HIGH** | Custodian. Holds the only key needed to release any claimable escrow to itself. Belongs in a KMS/HSM. |
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

### R7 in detail — the low-entropy commitment (fixed 2026-08-26)

`otpCommitHash` is a public value: `getTransfer()` returns it to anyone. The
original off-chain implementation computed the preimage as

```
otpReveal     = bytes32(uint256(<6-digit OTP>))
otpCommitHash = keccak256(abi.encode(otpReveal, transferId, recipient))
```

`transferId` and `recipient` are also public, so the commitment had roughly
**20 bits** of preimage entropy — about 900,000 candidates, exhaustible in
under a second on a laptop. Rate limiting the claim API did not help, because
the search is offline against public chain data. v1.0 of this document asserted
"OTP is 32 bytes on-chain… full 32-byte preimage entropy", which described the
*type* of the variable rather than its *contents*.

The contract is unchanged — it only ever compares a stored `bytes32` — and the
fix is in what `otpReveal` is:

```
claimSecret   = 32 cryptographically random bytes, delivered in the claim link
otpReveal     = keccak256(abi.encodePacked(claimSecret, otpDigits))
otpCommitHash = keccak256(abi.encode(otpReveal, transferId, recipient))
```

Inverting the commitment now requires guessing a 256-bit secret. The 6-digit OTP
remains as a human second factor, guarded online by an escalating per-transfer
lockout (15m → 1h → 6h → 24h after five failures).

Implementation: `frontend/lib/claim-secret.ts`. Regression tests, including one
that performs the original attack and asserts it now fails:
`frontend/__tests__/claim-secret.test.ts`.

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
| R1 | **Relayer key compromise** | Attacker releases every claimable escrow to the relayer address | Low (key handling) / Critical (impact) | **NOT mitigated by the contract.** Because the relayer is its own `recipient`, the OTP binding and the EIP-712 signature are both under one key. Mitigation is operational: KMS/HSM custody, gas-only balance, alerting on `TransferClaimed` volume, and the fact that releasing escrow does not pay anyone — the payout ledger does, with its own limits and reconciliation. |
| R2 | **Front-running OTP** — an observer sees `otpReveal` in the mempool and claims first | Attacker receives funds | Low | The commitment binds `recipient`, and only the relayer can produce a matching EIP-712 signature for that address. A third party cannot redirect the claim. |
| R3 | **Signature replay** — valid claim sig reused for different transfer | Double-claim | Low | EIP-712 includes `transferId` + `nonce`; nonce increments on each claim |
| R4 | **Expired transfer claimed** — transfer past 48h claimed | Stale claim, possible double-refund | Low | `block.timestamp >= t.expiry` checked strictly before any state change |
| R5 | **Admin pause traps funds** | Funds frozen indefinitely | Low | `cancelRemittance` is NOT `whenNotPaused`; users always retain refund path |
| R6 | **Idempotency — double-claim** | Double payment to recipient | Low | Status set to `CLAIMED` before external call (CEI); second call reverts on `TransferNotPending` |
| R7 | **OTP brute-force from the on-chain commitment** | Attacker recovers the claim credentials for any pending transfer | **Was CRITICAL; now mitigated** | See the extended note below. |
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

**Residual risk:** A compromised multisig with a 2-day timelock cannot steal
existing user funds before they expire and self-cancel. This is the designed
safety model.

### 5.1 Relayer key compromise

A separate and more likely scenario, and the one with the shortest path to loss.

**Impact:** the holder can call `claimRemittance` for every PENDING transfer
whose claim credentials they also hold, releasing that escrow to the relayer
address. They cannot touch transfers whose credentials they lack, and they
cannot redirect funds to a third address — `recipient` is bound in the
commitment — but the relayer address is theirs to drain.

**Controls:**
- Key held in a KMS/HSM; never in a plain environment variable in production.
- Relayer holds gas only; balances are swept, never accumulated.
- Alert on any `TransferClaimed` rate above the normal baseline.
- Releasing escrow pays nobody. The payout ledger is a separate system with its
  own idempotency, limits and reconciliation, so an on-chain drain does not
  automatically become a fiat drain.
- Rotation is a config change (`RELAYER_PRIVATE_KEY` +
  `NEXT_PUBLIC_RELAYER_ADDRESS`), but it invalidates the commitments of every
  in-flight transfer, so pending transfers must be allowed to expire and refund
  first.

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
4. **Phone number privacy** — `recipientPhoneHash` is `keccak(salt, phone)`. The
   original salt was the hard-coded public constant `0xDEADBEEF`, present in the
   source and in the shipped browser bundle, so every recipient's number was
   recoverable by a ~10^10 search over a national range. It is now keyed with a
   server-side secret (`PHONE_HASH_PEPPER`) and computed only on the server.
   **Residual risk:** an attacker who obtains the pepper AND the on-chain hashes
   can still enumerate numbers offline. The pepper must be handled like a
   database encryption key.
5. **Relayer custody** — see §5. The relayer key can release any claimable
   escrow. This is inherent to a wallet-less recipient model, not a bug, but it
   makes key custody the single most important operational control.
6. **Payout leg is not on-chain** — releasing escrow and paying fiat are two
   systems that cannot be made atomic. The design fails one-sidedly: a claimed
   transfer with no payout is detectable and repairable (`findOrphanedClaims`);
   a payout with no claim is not, so the ordering makes it impossible.
7. **No upgradability** — contracts are non-upgradeable by design. Bug fixes
   require redeployment + user migration.

---

## 8. Recommendations for Audit

1. **Verify CEI on all fund paths** in `EscrowVault` — `lockFunds`, `releaseFunds`, `refundFunds`.
2. **Validate `via-ir` compilation** does not introduce unexpected inlining that bypasses `nonReentrant`.
3. **Check that `Status.NONE` correctly represents "transfer does not exist"** — confirm that a default-zero `Transfer` struct cannot be manipulated to pass the `status != PENDING` check.
4. **Fuzz the EIP-712 domain separator** across different chain IDs to confirm no collision.
5. **Static analysis (Slither)** should be run with `--detect-all`; known false positives from OpenZeppelin's `_hashTypedDataV4` should be filtered.
6. **Consider a `maxTransferAmount` cap** per-transfer in addition to the daily limit to reduce single-transaction risk exposure.
