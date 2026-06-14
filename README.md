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
These contracts are live on the QIE Mainnet and can be verified on the [QIE Explorer](https://mainnet.qie.digital/):
- **Mock QUSD:** `0x9b5D310a92F05C3714E4163e43f226c7A6FB0827`
- **RemitChain (Main):** `0x56c650167e2D3a20A1131bC3b9e23449bC604AEa`
- **EscrowVault:** `0xbFC6e4dc09a59F9341EfACA72FFfff4ABF2e03FA`
- **KYCRegistry:** `0xaab80c35136e336f3d0fcf113bd1a092bf206832`
- **TimelockController:** `0xd26dc2efd20622867ef9e2c238047490652511d3`

### Judge Testing (OTP Access)
To test the full flow without needing access to the recipient's email/SMS inbox, judges can append the following `judge` token to the claim tracking URL. This securely exposes the 6-digit OTP in the UI for testing purposes.
**Judge Access Token:** `70d0afc902bb8fa4949fc024d3d236bd94fba607f6de4af2340f0da67000c32c`
Example usage: `https://remit-chain.vercel.app/track/123456?judge=70d0afc902bb8fa4949fc024d3d236bd94fba607f6de4af2340f0da67000c32c`

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
Create a `.env.local` file inside the `frontend` folder:
```env
NEXT_PUBLIC_CHAIN_ID=1990
NEXT_PUBLIC_RPC_URL=https://rpc-mainnet.qie.network
NEXT_PUBLIC_RELAYER_ADDRESS=0xYourRelayerAddress
RELAYER_PRIVATE_KEY=0xYourRelayerPrivateKey

# API Keys
RESEND_API_KEY=re_...
RAZORPAY_KEY_ID=rzp_...
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
