<div align="center">
  <img src="frontend/public/icon-512x512.png" alt="RemitChain Logo" width="120" height="120" />
  <h1>RemitChain</h1>
  <p><strong>Send money home. Not 5% of it.</strong></p>
  <p>
    Phone-number-only cross-border remittance powered by the QIE Blockchain. <br/>
    0.1% flat fee. No wallet needed for recipients.
  </p>
  <p>
    🚀 <strong><a href="https://remit-chain.vercel.app">remit-chain.vercel.app</a></strong>
  </p>
</div>

---

## 🌍 The Problem
Today, the 281 million people who send money home to their families face average fees of 6.2%. Remittance companies extract billions of dollars annually from the communities that need it most. 

While crypto solves the fee problem, it creates a UX nightmare: asking a family member in a developing nation to securely store a 24-word seed phrase, manage gas tokens, and navigate a DEX is simply not viable.

## 💡 Our Solution
**RemitChain** is a full-stack remittance platform disguised as a simple web app. 
We leverage the **QIE Blockchain** to drop cross-border fees to a flat **0.1%**, while completely abstracting away the crypto complexities for the recipient.

- **Sender:** Connects a wallet, enters a phone number, and sends QUSD (a stablecoin pegged to USD).
- **Recipient:** Receives an SMS link and a 6-digit OTP. They click the link, enter the OTP, and the funds are instantly released to their local bank account via fiat rails (e.g., UPI, SPEI, OPay) — *without ever knowing they interacted with a blockchain.*

## ❓ How It Works: Zero-Wallet Claim Flow

The most common question is: **How does the money reach the recipient's bank/mobile account just by their phone number, without them needing a crypto wallet?**

Here is the simple step-by-step flow:

1. **Preparing the transfer (server)**
   The sender enters an amount, a phone number and a destination country. The
   **server** mints a 6-digit OTP and a 256-bit claim secret, derives the
   commitments, and locks an FX quote. None of this happens in the browser — the
   OTP never touches the sender's device.

2. **Locking the funds (sender)**
   The sender's wallet locks QUSD in the `EscrowVault` contract. The contract
   stores no recipient address. Instead the funds are locked under:
   * a keyed hash of the recipient's phone number (`phoneHash`)
   * a commitment to the claim secret and OTP (`otpCommitHash`)

3. **Notifying the recipient (server)**
   Once the transaction is confirmed on-chain, the server emails the recipient a
   claim link and the 6-digit code. The claim secret rides in the URL *fragment*,
   so it never reaches a server log or a Referer header.

4. **Gasless claiming (the relayer)**
   The recipient opens the link, enters their phone number, the code, and where
   they want the money. They have no wallet, no keys and no gas, so the
   **relayer** verifies both credentials against the on-chain commitments and
   submits `claimRemittance`, paying the gas itself.

5. **Payout (the ledger)**
   Only **after** the on-chain claim is mined does a payout row get written and
   handed to a payment provider. A background worker submits it, retries with
   backoff, reconciles against provider webhooks, and escalates anything
   ambiguous to human review. Fiat never leaves before the escrow releases.

The recipient receives standard fiat currency directly in their bank account, without ever needing to touch crypto, create a wallet, or manage private keys!

## ✨ Key Features
- **Phone-Number Routing:** Send money globally using only the recipient's phone number. No 0x addresses.
- **On-Chain Escrow with OTP Claim:** Funds are locked in a secure smart contract (`EscrowVault`). The recipient claims them using a cryptographically hashed One-Time Password (OTP).
- **Gasless Receiving:** A backend Relayer covers the gas fees for the claim transaction. The recipient pays nothing and needs no wallet.
- **Biometric Security (WebAuthn):** Device-level biometric authentication (FaceID / TouchID) protects the user's dashboard and sending capabilities.
- **Fiat Off-ramping:** Seamless integration with fiat payout APIs (e.g., Razorpay) to settle directly to local bank accounts.

---

## 🏗️ Technical Architecture

RemitChain is composed of two main parts:

### 1. Smart Contracts (Foundry)
Written in Solidity and deployed on the **QIE Mainnet**.
- **`RemitChain.sol`**: The main entry point. Handles creating transfers, hashing phone numbers, and storing the OTP commit hash.
- **`EscrowVault.sol`**: Securely holds QUSD tokens while transfers are pending. Only releases funds when a valid OTP is provided.
- **`KYCRegistry.sol`**: Enforces daily and monthly sending limits natively on-chain.

### 2. Frontend & API (Next.js 14)
Built with React, Next.js App Router, and TailwindCSS.
- **Viem & Wagmi:** Used for reading on-chain state and broadcasting transactions.
- **Next.js Server Actions & Route Handlers:** Securely hold the `RELAYER_PRIVATE_KEY` to sign claim transactions on behalf of users.
- **IndexedDB & WebAuthn:** Enables secure local storage and biometric locking.

---

## 🏆 Hackathon Submission Details

### QIE Mainnet Contract Addresses
All contracts are deployed on the **QIE Mainnet** and verified on the [QIE Explorer](https://mainnet.qie.digital/):
- **Mock QUSD:** `0x9b5D310a92F05C3714E4163e43f226c7A6FB0827`
- **RemitChain (Main):** `0x56c650167e2D3a20A1131bC3b9e23449bC604AEa`
- **EscrowVault:** `0xbFC6e4dc09a59F9341EfACA72FFfff4ABF2e03FA`
- **KYCRegistry:** `0xaab80c35136e336f3d0fcf113bd1a092bf206832`
- **TimelockController:** `0xd26dc2efd20622867ef9e2c238047490652511d3`

---

## 📲 Local Fiat Payout Rails & Validation

RemitChain supports 5 major international corridors natively. Depending on the corridor selected by the sender, the recipient is prompted with the corresponding local bank or mobile wallet rail format:

| Corridor | Country | Rail | Account format | Provider | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `ae-in` | India | UPI | Virtual Payment Address | RazorpayX | **Live** |
| `us-mx` | Mexico | SPEI | 18-digit CLABE | — | Closed |
| `gb-ng` | Nigeria | OPay | 10-digit number | — | Closed |
| `sa-pk` | Pakistan | JazzCash | 11-digit number | — | Closed |
| `sg-bd` | Bangladesh | bKash | 11-digit number | — | Closed |

A corridor is **Closed** until a payout provider is implemented and its
credentials are configured. Closed corridors cannot be selected on the send page
and are rejected by the API — they never report a payout that did not happen.
See [`LAUNCH.md`](LAUNCH.md) for how to open one.


---

## 🔍 Judge Demo & Testing Guide

To test the full end-to-end remittance flow without needing a real recipient SMS inbox or phone number:

1. **Initiate Transfer**: Connect a Metamask/web3 wallet on the homepage, enter a recipient phone number (e.g. `+919876543210`), and send any amount of QUSD.
2. **Access Claim Details**: When the transfer transaction completes, click the claim link provided in the UI or SMS simulator.
3. **Judge OTP Reveal**: Append the secure `judge` token parameter to the claim page URL to view the OTP.
   - **Judge Token**: `70d0afc902bb8fa4949fc024d3d236bd94fba607f6de4af2340f0da67000c32c`
   - **Example Link**: `https://remit-chain.vercel.app/claim/<transferId>?otp=<otpCode>&judge=70d0afc902bb8fa4949fc024d3d236bd94fba607f6de4af2340f0da67000c32c`
4. **Claim Funds**: Click "Demo Mode — Reveal claim code" to auto-fill the OTP. Type the recipient phone number, enter a valid payout destination (e.g. `recipient@upi` for India or an 18-digit number for SPEI), and click **Claim Funds**.
5. **Success Tracking**: The gasless relayer claims the escrow on-chain, executes the fiat off-ramp payout (which runs in sandbox simulation mode to guarantee a successful payout under test credentials), updates the status, and redirects to the confirmation page.

---

## 🚀 Getting Started

### Prerequisites
- Node.js 20+
- `pnpm` (Package manager)
- [Foundry](https://book.getfoundry.sh/) (Smart contract toolkit)

### 1. Clone the repository
```bash
git clone https://github.com/UjjwalCodes01/RemitChain.git
cd RemitChain
```

### 2. Smart Contracts
Navigate to the `contracts` directory, install dependencies, and build:
```bash
cd contracts
forge install
forge build
```

**Deploying to QIE Testnet/Mainnet:**
Create a `.env` file in the `contracts` folder based on `.env.example` and run:
```bash
forge script script/Deploy.s.sol --rpc-url qie_mainnet --broadcast --verify
```

### 3. Frontend Web App
Navigate to the `frontend` directory and install dependencies:
```bash
cd ../frontend
pnpm install
```

**Environment Variables:**
```bash
cd frontend
cp .env.example .env
```

`.env.example` documents every value and marks which are required. On a
production chain the app **refuses to start** without them, naming exactly what
is missing — see `lib/env.server.ts`.

**Run migrations before first start:**
```bash
pnpm db:migrate
```

**Run the Development Server:**
```bash
pnpm dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🔐 Security

**The relayer is a custodian.** Because the recipient has no wallet, the relayer
is the on-chain `recipient` and signs its own claim authorization. Whoever holds
`RELAYER_PRIVATE_KEY` can release any claimable escrow to that address. Keep it
in a KMS/HSM, fund it with gas only, and alert on claim-rate anomalies.

**Claim credentials.** The value committed on-chain is
`keccak256(claimSecret ‖ otp)` where `claimSecret` is 256 random bits delivered
in the claim link. The 6-digit OTP alone is not enough to invert the commitment,
and online guessing is bounded by an escalating per-transfer lockout.

**Phone numbers** are committed with a server-side pepper and never stored in
full — only the commitment and a masked form for support.

Full analysis, including residual risks: [`contracts/THREAT_MODEL.md`](contracts/THREAT_MODEL.md).
Going live: [`LAUNCH.md`](LAUNCH.md).

---

## 📄 License
This project is licensed under the MIT License.
