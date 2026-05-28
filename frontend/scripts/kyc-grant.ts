// scripts/kyc-grant.ts
// Grants KYC level 1 to a wallet using the passOracle (RELAYER) key.
// Run: pnpm tsx scripts/kyc-grant.ts <wallet_address>
import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as fs from 'fs'
import * as path from 'path'

// Load .env from frontend and contracts directories
for (const envFile of ['.env', '../contracts/.env']) {
  const envPath = path.join(process.cwd(), envFile)
  if (!fs.existsSync(envPath)) continue
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    const k = t.slice(0, eq).trim()
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[k]) process.env[k] = v
  }
}

const RPC = 'https://rpc1testnet.qie.digital/'
const CHAIN_ID = 1983
const KYC_REGISTRY = '0xB388C8cdF22Bd89F0110620A0B557baA5d9D6eF1' as `0x${string}`

const userAddress = process.argv[2] as `0x${string}`
if (!userAddress) { console.error('Usage: pnpm tsx scripts/kyc-grant.ts <address>'); process.exit(1) }

const KYCRegistryAbi = [
  { type: 'function', name: 'verifyUser', inputs: [
    { name: 'user', type: 'address' },
    { name: 'newLevel', type: 'uint8' },
    { name: 'deadline', type: 'uint256' },
    { name: 'signature', type: 'bytes' },
  ], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'nonces', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getKYCLevel', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' },
] as const

const chain = {
  id: CHAIN_ID,
  name: 'QIE Testnet',
  nativeCurrency: { name: 'QIE', symbol: 'QIE', decimals: 18 },
  rpcUrls: { default: { http: [RPC] as [string] } },
} as const

async function main() {
  // passOracle is the deployer address — use DEPLOYER_PRIVATE_KEY
  const pk = (process.env.DEPLOYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY ?? process.env.RELAYER_PRIVATE_KEY) as `0x${string}` | undefined
  if (!pk) {
    console.error('❌ No private key found. Set DEPLOYER_PRIVATE_KEY in contracts/.env')
    process.exit(1)
  }

  const account = privateKeyToAccount(pk)
  console.log(`Using oracle account: ${account.address}`)

  const publicClient = createPublicClient({ chain, transport: http(RPC) })
  const walletClient = createWalletClient({ account, chain, transport: http(RPC) })

  // Check current level
  const currentLevel = await publicClient.readContract({
    address: KYC_REGISTRY, abi: KYCRegistryAbi, functionName: 'getKYCLevel', args: [userAddress],
  })
  console.log(`Current KYC level for ${userAddress}: ${currentLevel}`)
  if (currentLevel >= 1) { console.log('✅ Already KYC verified!'); return }

  const nonce = await publicClient.readContract({
    address: KYC_REGISTRY, abi: KYCRegistryAbi, functionName: 'nonces', args: [userAddress],
  })
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const newLevel = 1

  console.log(`Signing KYC attestation: user=${userAddress} level=${newLevel} nonce=${nonce}`)

  const signature = await walletClient.signTypedData({
    domain: { name: 'KYCRegistry', version: '1', chainId: CHAIN_ID, verifyingContract: KYC_REGISTRY },
    types: {
      VerifyUser: [
        { name: 'user', type: 'address' },
        { name: 'newLevel', type: 'uint8' },
        { name: 'deadline', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'VerifyUser',
    message: { user: userAddress, newLevel, deadline, nonce },
  })

  console.log('Submitting verifyUser tx...')
  const txHash = await walletClient.writeContract({
    address: KYC_REGISTRY,
    abi: KYCRegistryAbi,
    functionName: 'verifyUser',
    args: [userAddress, newLevel, deadline, signature],
  })

  console.log(`Tx: ${txHash}`)
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
  console.log(`✅ Confirmed in block ${receipt.blockNumber} — ${userAddress} is now KYC level 1`)
}

main().catch(e => { console.error(e); process.exit(1) })
