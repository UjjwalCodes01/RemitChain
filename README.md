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

1. **Locking the Funds (Sender)**
   The sender locks stablecoins (QUSD) inside the `EscrowVault` smart contract on-chain. The contract doesn't store a wallet address for the recipient. Instead, it locks the funds cryptographically under:
   * A hash of the recipient's phone number (`phoneHash`).
   * A hash of a random 6-digit passcode/OTP (`otpHash`).

2. **Notifying the Recipient**
   The recipient gets a claim link (via SMS or email) containing the transaction ID and the 6-digit OTP code.

3. **Gasless Backend Claiming (The Relayer)**
   The recipient opens the link, enters their phone number, and inputs the OTP. Since they don't have a wallet, private keys, or gas (QIE) to execute blockchain transactions, they submit the form to our **Relayer** (a secure backend server). The Relayer:
   * Verifies the OTP and phone number match the on-chain lock.
   * Signs the claim transaction and pays the network transaction fee (gas) on behalf of the recipient.
   * Unlocks the QUSD from the smart contract.

4. **Direct Bank Deposit (The Off-ramp)**
   Once the Relayer unlocks the QUSD, it doesn't send crypto to the user. Instead, the Relayer immediately hands the QUSD to a local off-ramp payment provider (e.g., Razorpay/UPI in India, SPEI in Mexico, or GCash in the Philippines). The provider converts the stablecoins to local fiat currency and deposits it **directly into the recipient's bank account or mobile wallet** linked to their phone number.

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

| Corridor Index | Country | Local Rail | Account Format | Validator Regex / Logic | API Provider |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1 (ae-in)** | India | UPI | Virtual Payment Address (VPA) | `^[\w.-]+@[\w.-]+$` | Razorpay Payouts (Real API) |
| **2 (us-mx)** | Mexico | SPEI | 18-digit CLABE code | `^\d{18}$` | SPEI Stub (Simulated Rail) |
| **3 (gb-ng)** | Nigeria | OPay | 10-digit mobile number | `^\d{10}$` | OPay Stub (Simulated Rail) |
| **4 (sa-pk)** | Pakistan | JazzCash | 11-digit mobile number | `^\d{11}$` | JazzCash Stub (Simulated Rail) |
| **5 (sg-bd)** | Bangladesh | bKash | 11-digit wallet number | `^\d{11}$` | bKash Stub (Simulated Rail) |

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
Create a `.env` file inside the `frontend` folder:
```env
NEXT_PUBLIC_CHAIN_ID=1990
NEXT_PUBLIC_RPC_URL=https://rpc1mainnet.qie.digital/
NEXT_PUBLIC_RELAYER_ADDRESS=0xYourRelayerAddress
RELAYER_PRIVATE_KEY=0xYourRelayerPrivateKey

# API Keys (If using 'rzp_test_' keys, the app automatically runs in sandbox simulation mode)
RESEND_API_KEY=re_...
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
```

**Run the Development Server:**
```bash
pnpm dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🔐 Security & Relayer Setup
The architecture heavily relies on a backend relayer. **Never expose the `RELAYER_PRIVATE_KEY` on the client.** 
When a recipient submits their OTP on the claim page, the Next.js API route takes the OTP, constructs the transaction, and the Relayer signs and pays the QIE gas fee to execute `claimRemittance()` on the blockchain.

---

## 📄 License
This project is licensed under the MIT License.
