#!/usr/bin/env tsx
/**
 * scripts/e2e-local.ts
 *
 * End-to-end verification of the real money path against a real chain.
 *
 * This is not a unit test with mocks. It runs the ACTUAL application modules —
 * the same `lib/claim-secret.ts`, `lib/phone.ts`, `lib/transfer-id.ts`,
 * `lib/relayer/claim.ts` and `lib/corridors.ts` the server uses — against
 * contracts genuinely deployed on a local anvil node, and asserts that QUSD
 * actually moves.
 *
 * It exists because everything else in the suite verifies one layer at a time.
 * The failure mode this catches is the one that matters: a derivation that is
 * self-consistent in TypeScript but does not reproduce the commitment the
 * deployed Solidity checks. That bug passes every unit test and loses money.
 *
 * Usage:
 *   anvil --port 8545 --chain-id 31337 &
 *   cd contracts && forge script script/DeployLocal.s.sol \
 *     --rpc-url http://127.0.0.1:8545 --broadcast
 *   cd frontend && pnpm sync:abis && pnpm e2e:local
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  decodeEventLog,
  defineChain,
  type Hex,
} from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

// ── Environment must be in place before the app modules load ────────────────
process.env.NEXT_PUBLIC_CHAIN_ID = '31337'
process.env.NEXT_PUBLIC_RPC_URL = 'http://127.0.0.1:8545'
process.env.PHONE_HASH_PEPPER = '0x' + '11'.repeat(32)
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
delete process.env.ALLOW_LEGACY_OTP_SCHEME

const RPC = 'http://127.0.0.1:8545'

// Standard anvil accounts.
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const ORACLE   = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
/**
 * A FRESH sender every run.
 *
 * A fixed account accumulates state on a long-lived anvil node: its KYC tier
 * persists, and its daily allowance is consumed, so a second run fails with
 * DailyLimitExceeded through no fault of the code. Deriving a new key each time
 * makes the script idempotent.
 */
const SENDER = generatePrivateKey()
const RELAYER  = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex
const TREASURY = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' as Hex // anvil #4, distinct from every other actor

const anvil = defineChain({
  id: 31337,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})

// ── Assertions ──────────────────────────────────────────────────────────────

let passed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${label}`)
  } else {
    failures.push(label)
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

async function main() {
  // Imported after env is set — these read it at module load.
  const { REMITCHAIN_ADDRESS, ESCROW_VAULT_ADDRESS, KYC_REGISTRY_ADDRESS, QUSD_ADDRESS, FEE_BPS, RemitChainAbi, KYCRegistryAbi, ERC20Abi } = await import('../lib/contracts')
  const { generateClaimCredentials, deriveCommitment, deriveOtpReveal, legacyOtpReveal } = await import('../lib/claim-secret')
  const { computePhoneHash, parsePhone, phoneHashMatches, maskPhone } = await import('../lib/phone')
  const { computeTransferId } = await import('../lib/transfer-id')
  const { getCorridorById, validateDestination, maskDestination } = await import('../lib/corridors')
  const { buildAndBroadcastClaim, ChainStatus } = await import('../lib/relayer/claim')

  const publicClient = createPublicClient({ chain: anvil, transport: http(RPC) })
  const deployer = privateKeyToAccount(DEPLOYER)
  const oracle = privateKeyToAccount(ORACLE)
  const sender = privateKeyToAccount(SENDER)
  const relayer = privateKeyToAccount(RELAYER)

  const deployerWallet = createWalletClient({ account: deployer, chain: anvil, transport: http(RPC) })
  const senderWallet = createWalletClient({ account: sender, chain: anvil, transport: http(RPC) })

  console.log('\x1b[1m\nRemitChain — end-to-end verification against a live chain\x1b[0m')
  console.log(`  RemitChain ${REMITCHAIN_ADDRESS}`)
  console.log(`  QUSD       ${QUSD_ADDRESS}`)
  console.log(`  sender     ${sender.address}`)
  console.log(`  relayer    ${relayer.address}`)

  section('0. Wiring')
  check('contracts.ts resolved the local deployment',
    !/^0x0+$/.test(REMITCHAIN_ADDRESS),
    'run: forge script DeployLocal.s.sol && pnpm sync:abis')

  const onChainVault = await publicClient.readContract({
    address: REMITCHAIN_ADDRESS, abi: RemitChainAbi, functionName: 'vault',
  }) as Hex
  check('RemitChain points at the EscrowVault the frontend uses',
    onChainVault.toLowerCase() === ESCROW_VAULT_ADDRESS.toLowerCase(),
    `chain=${onChainVault} app=${ESCROW_VAULT_ADDRESS}`)

  // ── Fund + verify the sender ──────────────────────────────────────────────
  section('1. Funding and KYC')
  const AMOUNT = parseUnits('100', 6)

  // A freshly derived account has no native balance for gas.
  await publicClient.waitForTransactionReceipt({
    hash: await deployerWallet.sendTransaction({ to: sender.address, value: 10n ** 18n }),
  })
  await publicClient.waitForTransactionReceipt({
    hash: await deployerWallet.writeContract({
      address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'transfer',
      args: [sender.address, parseUnits('1000', 6)],
    }),
  })
  const senderBal = await publicClient.readContract({
    address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'balanceOf', args: [sender.address],
  }) as bigint
  check('sender funded with QUSD', senderBal >= AMOUNT, formatUnits(senderBal, 6))

  // Tier 0 must be refused. This also proves the client can DECODE the error:
  // `KYCRequired` is declared on KYCRegistry, not RemitChain, so before the ABI
  // merge in sync-abis.ts this surfaced as undecodable hex and the send page's
  // friendly message for it was unreachable.
  let tier0Error = ''
  try {
    await publicClient.simulateContract({
      account: sender, address: REMITCHAIN_ADDRESS, abi: RemitChainAbi,
      functionName: 'sendRemittance',
      args: ['0x'.padEnd(66, '0') as Hex, AMOUNT, '0x'.padEnd(66, '0') as Hex, 1],
    })
  } catch (e) {
    tier0Error = String(e)
  }
  check('unverified wallet is refused with a decodable KYCRequired',
    tier0Error.includes('KYCRequired'),
    tier0Error.slice(0, 120))

  // Grant tier 1 via a real EIP-712 oracle attestation.
  const kycNonce = await publicClient.readContract({
    address: KYC_REGISTRY_ADDRESS, abi: KYCRegistryAbi, functionName: 'nonces', args: [sender.address],
  }) as bigint
  const kycDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const kycSig = await createWalletClient({ account: oracle, chain: anvil, transport: http(RPC) })
    .signTypedData({
      domain: { name: 'KYCRegistry', version: '1', chainId: 31337, verifyingContract: KYC_REGISTRY_ADDRESS },
      types: { VerifyUser: [
        { name: 'user', type: 'address' }, { name: 'newLevel', type: 'uint8' },
        { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
      ] },
      primaryType: 'VerifyUser',
      message: { user: sender.address, newLevel: 1, deadline: kycDeadline, nonce: kycNonce },
    })
  await publicClient.waitForTransactionReceipt({
    hash: await deployerWallet.writeContract({
      address: KYC_REGISTRY_ADDRESS, abi: KYCRegistryAbi, functionName: 'verifyUser',
      args: [sender.address, 1, kycDeadline, kycSig],
    }),
  })
  const level = await publicClient.readContract({
    address: KYC_REGISTRY_ADDRESS, abi: KYCRegistryAbi, functionName: 'getKYCLevel', args: [sender.address],
  }) as number
  check('oracle attestation raised the sender to tier 1', Number(level) === 1, `level=${level}`)

  // ── PREPARE (exactly what /api/transfers/prepare does) ────────────────────
  section('2. Prepare — server-side credential minting')

  const corridor = getCorridorById('ae-in')!
  const phoneInput = '09876543210'
  const phone = parsePhone(phoneInput, corridor.recvCountry)
  check('national phone normalised to E.164', phone.ok && phone.e164 === '+919876543210', phone.e164)
  check('masked form hides the subscriber number', !maskPhone(phone.e164).includes('98765'))

  const senderNonce = await publicClient.readContract({
    address: REMITCHAIN_ADDRESS, abi: RemitChainAbi, functionName: 'senderNonces', args: [sender.address],
  }) as bigint

  const transferId = computeTransferId({
    sender: sender.address, nonce: senderNonce, chainId: 31337n, remitChain: REMITCHAIN_ADDRESS,
  })

  const { claimSecret, otp } = generateClaimCredentials()
  const { otpCommitHash } = deriveCommitment(claimSecret, otp, transferId, relayer.address)
  const phoneHash = computePhoneHash(phone.e164)

  const destination = validateDestination(corridor, 'Ramesh.K@okhdfcbank')
  check('UPI destination validated and normalised', destination.ok && destination.value === 'ramesh.k@okhdfcbank', destination.value)
  check('destination masked for logs', !maskDestination(corridor, destination.value).includes('ramesh'))

  // ── SEND (what the browser does) ──────────────────────────────────────────
  section('3. Send — approve + sendRemittance')

  await publicClient.waitForTransactionReceipt({
    hash: await senderWallet.writeContract({
      address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'approve',
      args: [ESCROW_VAULT_ADDRESS, AMOUNT],
    }),
  })

  const vaultBeforeSend = await publicClient.readContract({
    address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'balanceOf', args: [ESCROW_VAULT_ADDRESS],
  }) as bigint

  const sendReceipt = await publicClient.waitForTransactionReceipt({
    hash: await senderWallet.writeContract({
      address: REMITCHAIN_ADDRESS, abi: RemitChainAbi, functionName: 'sendRemittance',
      args: [phoneHash, AMOUNT, otpCommitHash, corridor.index],
    }),
  })
  check('sendRemittance succeeded', sendReceipt.status === 'success')

  // ── CONFIRM (what /api/transfers/confirm does) ────────────────────────────
  let emittedId: Hex | null = null
  let emittedExpiry = 0n
  for (const entry of sendReceipt.logs) {
    if (entry.address.toLowerCase() !== REMITCHAIN_ADDRESS.toLowerCase()) continue
    try {
      const decoded = decodeEventLog({ abi: RemitChainAbi, data: entry.data, topics: entry.topics })
      if (decoded.eventName === 'TransferInitiated') {
        const a = decoded.args as unknown as { transferId: Hex; expiry: bigint }
        emittedId = a.transferId
        emittedExpiry = a.expiry
      }
    } catch { /* not our event */ }
  }
  check('TransferInitiated decoded from the receipt', emittedId !== null)
  check('locally computed transferId matches the chain',
    emittedId?.toLowerCase() === transferId.toLowerCase(),
    `computed=${transferId} chain=${emittedId}`)

  const stored = await publicClient.readContract({
    address: REMITCHAIN_ADDRESS, abi: RemitChainAbi, functionName: 'getTransfer', args: [transferId],
  }) as { status: number; amount: bigint; recipientPhoneHash: Hex; otpCommitHash: Hex; expiry: bigint }

  check('transfer is PENDING on-chain', stored.status === ChainStatus.PENDING)
  check('escrow holds the full amount', stored.amount === AMOUNT, formatUnits(stored.amount, 6))
  check('peppered phone hash matches the on-chain commitment',
    phoneHashMatches(phone.e164, stored.recipientPhoneHash))
  check('a different phone number does NOT match',
    !phoneHashMatches('+919999999999', stored.recipientPhoneHash))

  const vaultAfterSend = await publicClient.readContract({
    address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'balanceOf', args: [ESCROW_VAULT_ADDRESS],
  }) as bigint
  // Relative, not absolute: the chain may already hold other pending transfers.
  check('vault custody increased by exactly the amount sent',
    vaultAfterSend - vaultBeforeSend === AMOUNT,
    formatUnits(vaultAfterSend - vaultBeforeSend, 6))

  // ── CLAIM — credential checks against the deployed contract ───────────────
  section('4. Claim — credential verification')

  // Wrong OTP must be rejected BY THE CONTRACT, not just by our own comparison.
  let wrongOtpRejected = false
  try {
    const wrongOtp = otp === '000000' ? '000001' : '000000'
    await buildAndBroadcastClaim({
      transferId, otpReveal: deriveOtpReveal(claimSecret, wrongOtp),
      relayerPrivateKey: RELAYER, relayerAddress: relayer.address,
      rpcUrl: RPC, chain: anvil,
    })
  } catch (e) {
    wrongOtpRejected = String(e).includes('InvalidOTPReveal')
  }
  check('contract rejects a wrong OTP with InvalidOTPReveal', wrongOtpRejected)

  // The legacy low-entropy reveal must not open a modern commitment.
  let legacyRejected = false
  try {
    await buildAndBroadcastClaim({
      transferId, otpReveal: legacyOtpReveal(otp),
      relayerPrivateKey: RELAYER, relayerAddress: relayer.address,
      rpcUrl: RPC, chain: anvil,
    })
  } catch (e) {
    legacyRejected = String(e).includes('InvalidOTPReveal')
  }
  check('legacy OTP scheme cannot open a modern commitment', legacyRejected)

  // ── CLAIM — the real thing ────────────────────────────────────────────────
  section('5. Claim — real settlement')

  const relayerBefore = await publicClient.readContract({
    address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'balanceOf', args: [relayer.address],
  }) as bigint
  const treasuryBefore = await publicClient.readContract({
    address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'balanceOf', args: [TREASURY],
  }) as bigint

  const claim = await buildAndBroadcastClaim({
    transferId, otpReveal: deriveOtpReveal(claimSecret, otp),
    relayerPrivateKey: RELAYER, relayerAddress: relayer.address,
    rpcUrl: RPC, chain: anvil,
  })
  check('claimRemittance broadcast and mined', Boolean(claim.txHash))

  const afterClaim = await publicClient.readContract({
    address: REMITCHAIN_ADDRESS, abi: RemitChainAbi, functionName: 'getTransfer', args: [transferId],
  }) as { status: number }
  check('transfer is CLAIMED on-chain', afterClaim.status === ChainStatus.CLAIMED)

  const expectedFee = (AMOUNT * BigInt(FEE_BPS)) / 10_000n
  const expectedNet = AMOUNT - expectedFee

  const relayerAfter = await publicClient.readContract({
    address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'balanceOf', args: [relayer.address],
  }) as bigint
  const treasuryAfter = await publicClient.readContract({
    address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'balanceOf', args: [TREASURY],
  }) as bigint

  const netReceived = relayerAfter - relayerBefore
  const feeReceived = treasuryAfter - treasuryBefore

  check('recipient received the NET amount (gross minus fee)',
    netReceived === expectedNet,
    `got ${formatUnits(netReceived, 6)} expected ${formatUnits(expectedNet, 6)}`)
  check('treasury received exactly the 0.1% fee',
    feeReceived === expectedFee,
    `got ${formatUnits(feeReceived, 6)} expected ${formatUnits(expectedFee, 6)}`)
  check('vault released exactly what it held for this transfer — no dust',
    vaultAfterSend - (await publicClient.readContract({
      address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'balanceOf', args: [ESCROW_VAULT_ADDRESS],
    }) as bigint) === AMOUNT)

  // ── Payout amount, from the settled net ───────────────────────────────────
  section('6. Payout conversion')
  const { convertToMinor } = await import('../lib/fx/rates')
  const rate = 95.43 // fixed here so the assertion is deterministic
  const payoutMinor = convertToMinor(netReceived, rate, corridor.minorUnits)
  const grossMinor = convertToMinor(AMOUNT, rate, corridor.minorUnits)
  check('payout is computed from the NET, not the gross',
    payoutMinor < grossMinor,
    `net=${payoutMinor} gross=${grossMinor}`)
  check('payout equals the settled amount at the quoted rate',
    payoutMinor === Math.round(Number(netReceived) / 1e6 * rate * 100),
    `${corridor.currencySymbol}${(payoutMinor / 100).toFixed(2)}`)

  // ── Replay ────────────────────────────────────────────────────────────────
  section('7. Replay protection')
  let replayRejected = false
  try {
    await buildAndBroadcastClaim({
      transferId, otpReveal: deriveOtpReveal(claimSecret, otp),
      relayerPrivateKey: RELAYER, relayerAddress: relayer.address,
      rpcUrl: RPC, chain: anvil,
    })
  } catch (e) {
    replayRejected = String(e).includes('TransferNotPending')
  }
  check('a claimed transfer cannot be claimed twice', replayRejected)

  // ── Refund path ───────────────────────────────────────────────────────────
  section('8. Refund path')
  const nonce2 = await publicClient.readContract({
    address: REMITCHAIN_ADDRESS, abi: RemitChainAbi, functionName: 'senderNonces', args: [sender.address],
  }) as bigint
  const id2 = computeTransferId({ sender: sender.address, nonce: nonce2, chainId: 31337n, remitChain: REMITCHAIN_ADDRESS })
  const cred2 = generateClaimCredentials()
  const commit2 = deriveCommitment(cred2.claimSecret, cred2.otp, id2, relayer.address).otpCommitHash

  await publicClient.waitForTransactionReceipt({
    hash: await senderWallet.writeContract({
      address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'approve', args: [ESCROW_VAULT_ADDRESS, AMOUNT],
    }),
  })
  await publicClient.waitForTransactionReceipt({
    hash: await senderWallet.writeContract({
      address: REMITCHAIN_ADDRESS, abi: RemitChainAbi, functionName: 'sendRemittance',
      args: [computePhoneHash('+919876543211'), AMOUNT, commit2, corridor.index],
    }),
  })

  const senderBeforeRefund = await publicClient.readContract({
    address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'balanceOf', args: [sender.address],
  }) as bigint

  await publicClient.waitForTransactionReceipt({
    hash: await senderWallet.writeContract({
      address: REMITCHAIN_ADDRESS, abi: RemitChainAbi, functionName: 'cancelRemittance', args: [id2],
    }),
  })

  const senderAfterRefund = await publicClient.readContract({
    address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'balanceOf', args: [sender.address],
  }) as bigint
  check('cancel refunds the FULL amount, no fee taken',
    senderAfterRefund - senderBeforeRefund === AMOUNT,
    formatUnits(senderAfterRefund - senderBeforeRefund, 6))

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n\x1b[1m${'─'.repeat(64)}\x1b[0m`)
  if (failures.length === 0) {
    console.log(`\x1b[32m\x1b[1m  ${passed} checks passed — the money path works end to end.\x1b[0m`)
    console.log(`  Expiry window: ${Math.round(Number(emittedExpiry) - Date.now() / 1000) / 3600}h`)
  } else {
    console.log(`\x1b[31m\x1b[1m  ${failures.length} FAILED, ${passed} passed\x1b[0m`)
    failures.forEach(f => console.log(`\x1b[31m    - ${f}\x1b[0m`))
    process.exitCode = 1
  }
  console.log('')
}

main().catch(e => {
  console.error('\n\x1b[31mFatal:\x1b[0m', e)
  process.exit(1)
})
