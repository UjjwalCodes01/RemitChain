#!/usr/bin/env tsx
/**
 * scripts/predeploy-check.ts
 *
 * Validates a mainnet deployment configuration BEFORE any key is loaded and
 * before any gas is spent.
 *
 * `Deploy.s.sol` enforces the same rules, but it enforces them *during* the
 * broadcast — by which point you have loaded the deployer key and, if the run
 * partially succeeded, possibly deployed something. This checks the same
 * conditions against live mainnet state using nothing but public addresses, so
 * the deployer key stays offline until everything already passes.
 *
 * It reads addresses, never keys. Nothing here can sign or send.
 *
 * Usage:
 *   QUSD_ADDRESS=0x… MULTISIG_ADDRESS=0x… PASS_ORACLE_ADDRESS=0x… \
 *   FEE_TREASURY_ADDRESS=0x… DEPLOYER_ADDRESS=0x… \
 *   RPC_URL=https://rpc1mainnet.qie.digital/ \
 *   pnpm predeploy:check
 */

import { createPublicClient, http, isAddress, formatEther, getAddress, type Hex } from 'viem'

const RPC = process.env.RPC_URL ?? 'https://rpc1mainnet.qie.digital/'
const EXPECTED_CHAIN_ID = Number(process.env.EXPECTED_CHAIN_ID ?? '1990')

/** QUSDC on QIE mainnet — verified 2026-08-26. */
const KNOWN_GOOD_TOKEN = '0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5'
/** The MockQUSD this project deployed for testing. Never settle against it. */
const KNOWN_MOCK_TOKEN = '0x9b5D310a92F05C3714E4163e43f226c7A6FB0827'

/** Rough ceiling for deploying four contracts. */
const MIN_DEPLOYER_BALANCE_WEI = 10n ** 17n // 0.1 QIE

const ERC20 = [
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const

let blocking = 0
let warnings = 0

const ok = (m: string, d?: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}${d ? ` — ${d}` : ''}`)
const warn = (m: string, d?: string) => { warnings++; console.log(`  \x1b[33m!\x1b[0m ${m}${d ? ` — ${d}` : ''}`) }
const bad = (m: string, d?: string) => { blocking++; console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? ` — ${d}` : ''}`) }
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`)

function readAddress(name: string): Hex | null {
  const raw = process.env[name]
  if (!raw) { bad(`${name} is not set`); return null }
  if (!isAddress(raw)) { bad(`${name} is not a valid address`, raw); return null }
  return getAddress(raw) as Hex
}

async function main() {
  console.log('\n\x1b[1mRemitChain — pre-deployment check\x1b[0m')
  console.log(`  rpc ${RPC}`)

  // ── Connectivity ─────────────────────────────────────────────────────────
  section('Network')
  const client = createPublicClient({ transport: http(RPC, { timeout: 20_000, retryCount: 1 }) })

  let chainId: number
  try {
    chainId = await client.getChainId()
    if (chainId === EXPECTED_CHAIN_ID) ok(`connected to chain ${chainId}`)
    else bad(`connected to chain ${chainId}, expected ${EXPECTED_CHAIN_ID}`)
  } catch (err) {
    bad('cannot reach the RPC endpoint', String(err).slice(0, 120))
    console.log('\n  Nothing else can be checked without a working RPC. This same')
    console.log('  endpoint serves every read, send and claim in production.')
    return summarise()
  }

  try {
    ok(`current block ${await client.getBlockNumber()}`)
  } catch { warn('could not read the current block') }

  // ── Addresses ────────────────────────────────────────────────────────────
  section('Configuration')
  const qusd = readAddress('QUSD_ADDRESS')
  const multisig = readAddress('MULTISIG_ADDRESS')
  const oracle = readAddress('PASS_ORACLE_ADDRESS')
  const treasury = readAddress('FEE_TREASURY_ADDRESS')
  const deployer = readAddress('DEPLOYER_ADDRESS')

  if (!qusd || !multisig || !oracle || !treasury || !deployer) {
    console.log('\n  Set every address above and re-run.')
    return summarise()
  }

  // ── Key separation ───────────────────────────────────────────────────────
  section('Key separation')

  if (deployer === multisig) {
    bad('MULTISIG_ADDRESS is the deployer', 'the timelock would be controlled by the key that deployed it')
  } else ok('multisig differs from the deployer')

  if (deployer === oracle) {
    bad('PASS_ORACLE_ADDRESS is the deployer',
      'one key could then deploy, grant any KYC tier, and act as the timelock')
  } else ok('pass oracle differs from the deployer')

  if (oracle === multisig) {
    warn('pass oracle is the multisig', 'a compromise of one is a compromise of both')
  } else ok('pass oracle differs from the multisig')

  // ── Multisig must be a contract ──────────────────────────────────────────
  section('Custody')
  try {
    const code = await client.getBytecode({ address: multisig })
    if (!code || code === '0x') {
      bad('MULTISIG_ADDRESS is an EOA, not a contract',
        'deploy a Gnosis Safe — a 2-day timelock protects nothing when one key proposes and executes')
    } else {
      ok('multisig is a contract', `${(code.length - 2) / 2} bytes of code`)
    }
  } catch { warn('could not check whether the multisig is a contract') }

  // ── Token ────────────────────────────────────────────────────────────────
  section('Settlement token')

  if (qusd.toLowerCase() === KNOWN_MOCK_TOKEN.toLowerCase()) {
    bad('QUSD_ADDRESS is MockQUSD',
      'owner-mintable test token with no redemption path — real value cannot settle against it')
  } else if (qusd.toLowerCase() === KNOWN_GOOD_TOKEN.toLowerCase()) {
    ok('QUSD_ADDRESS is QUSDC', 'verified, vault-redeemable')
  } else {
    warn('QUSD_ADDRESS is not the token this project has verified',
      'confirm its decimals and redemption path yourself')
  }

  try {
    const code = await client.getBytecode({ address: qusd })
    if (!code || code === '0x') {
      bad('QUSD_ADDRESS has no code on this chain')
    } else {
      const [decimals, symbol, supply] = await Promise.all([
        client.readContract({ address: qusd, abi: ERC20, functionName: 'decimals' }),
        client.readContract({ address: qusd, abi: ERC20, functionName: 'symbol' }).catch(() => '?'),
        client.readContract({ address: qusd, abi: ERC20, functionName: 'totalSupply' }).catch(() => 0n),
      ])

      if (Number(decimals) === 6) ok(`${symbol} reports 6 decimals`)
      else bad(`${symbol} reports ${decimals} decimals, not 6`,
        'MIN_AMOUNT and the fee arithmetic assume 6')

      const human = Number(supply as bigint) / 1e6
      if (human < 100_000) {
        warn(`total supply is ${human.toLocaleString()} ${symbol}`,
          'that is the entire float on this chain — size your launch limits against it')
      } else {
        ok(`total supply ${human.toLocaleString()} ${symbol}`)
      }
    }
  } catch (err) {
    bad('could not read the token', String(err).slice(0, 120))
  }

  // ── Gas ──────────────────────────────────────────────────────────────────
  section('Deployer funding')
  try {
    const balance = await client.getBalance({ address: deployer })
    if (balance < MIN_DEPLOYER_BALANCE_WEI) {
      bad(`deployer holds ${formatEther(balance)} QIE`, 'not enough to deploy four contracts')
    } else {
      ok(`deployer holds ${formatEther(balance)} QIE`)
    }
  } catch { warn('could not read the deployer balance') }

  // ── Treasury ─────────────────────────────────────────────────────────────
  section('Fee treasury')
  if (treasury === deployer) {
    warn('fee treasury is the deployer', 'fees will accrue to a key that should go offline after deploy')
  } else {
    ok('fee treasury is a separate address')
  }

  summarise()
}

function summarise() {
  console.log(`\n\x1b[1m${'─'.repeat(66)}\x1b[0m`)
  if (blocking > 0) {
    console.log(`\x1b[31m\x1b[1m  DO NOT DEPLOY — ${blocking} blocking issue(s), ${warnings} warning(s)\x1b[0m`)
    console.log('  Deploy.s.sol would reject this run, but fix it before loading the')
    console.log('  deployer key rather than after.\n')
    process.exitCode = 1
  } else if (warnings > 0) {
    console.log(`\x1b[33m\x1b[1m  READY, with ${warnings} warning(s) — read them first\x1b[0m\n`)
  } else {
    console.log('\x1b[32m\x1b[1m  READY TO DEPLOY\x1b[0m\n')
  }
}

main().catch(e => { console.error('\n\x1b[31mCheck failed:\x1b[0m', e); process.exit(1) })
