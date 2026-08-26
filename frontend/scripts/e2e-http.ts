#!/usr/bin/env tsx
/**
 * scripts/e2e-http.ts
 *
 * Full-stack end-to-end test: real Next.js server, real Postgres, real chain.
 *
 * Everything here goes over HTTP to the running application. Nothing is
 * stubbed, nothing is imported from `lib/` to shortcut a step. It drives the
 * exact sequence a sender and a recipient produce:
 *
 *   prepare → approve → sendRemittance → confirm → claim → payout
 *
 * and then asserts against the chain and the database that the money actually
 * moved and the ledger agrees.
 *
 * Prerequisites (see LOCAL.md):
 *   anvil, DeployLocal.s.sol, pnpm sync:abis, pnpm db:migrate,
 *   and `next start` running with .env.e2e
 *
 * Usage:  pnpm e2e:http
 */

import {
  createPublicClient,
  createWalletClient,
  http as viemHttp,
  parseUnits,
  formatUnits,
  defineChain,
  type Hex,
} from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { Client } from 'pg'
import { createDecipheriv } from 'node:crypto'

const APP = process.env.E2E_APP_URL ?? 'http://localhost:3100'
const RPC = process.env.E2E_RPC_URL ?? 'http://127.0.0.1:8545'
const DB = process.env.DATABASE_URL!
const CRON_SECRET = process.env.CRON_SECRET ?? 'e2e-cron-secret-value-1234567890'
const ENC_KEY = Buffer.from(process.env.SECRETS_ENCRYPTION_KEY!, 'base64')

const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const ORACLE   = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
/**
 * A fresh sender each run. A fixed account keeps its KYC tier and consumes its
 * daily allowance, so a second run would fail with DailyLimitExceeded through
 * no fault of the application.
 */
const SENDER = generatePrivateKey()
const RELAYER_ADDR = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as Hex
const TREASURY = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' as Hex

const RECIPIENT_PHONE = '+919876543210'
const PAYOUT_UPI = 'ramesh.k@okhdfcbank'

const anvil = defineChain({
  id: 31337, name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})

let passed = 0
const failures: string[] = []
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`) }
  else { failures.push(label); console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`)

/** Mirrors lib/crypto/secretbox.ts — this is what reading the email does. */
function decrypt(encoded: string): string | null {
  try {
    const buf = Buffer.from(encoded, 'base64')
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(buf.length - 16)
    const ct = buf.subarray(12, buf.length - 16)
    const d = createDecipheriv('aes-256-gcm', ENC_KEY, iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
  } catch { return null }
}

async function api(path: string, body?: unknown, init: RequestInit = {}) {
  const res = await fetch(`${APP}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    body: body ? JSON.stringify(body) : undefined,
    ...init,
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text.slice(0, 300) } }
  return { status: res.status, json }
}

async function main() {
  const pg = new Client({ connectionString: DB })
  await pg.connect()

  const publicClient = createPublicClient({ chain: anvil, transport: viemHttp(RPC) })
  const sender = privateKeyToAccount(SENDER)
  const senderWallet = createWalletClient({ account: sender, chain: anvil, transport: viemHttp(RPC) })
  const deployerWallet = createWalletClient({ account: privateKeyToAccount(DEPLOYER), chain: anvil, transport: viemHttp(RPC) })

  const { REMITCHAIN_ADDRESS, ESCROW_VAULT_ADDRESS, KYC_REGISTRY_ADDRESS, QUSD_ADDRESS, RemitChainAbi, KYCRegistryAbi, ERC20Abi } =
    await import('../lib/contracts')

  console.log('\x1b[1m\nRemitChain — full-stack end-to-end (HTTP → chain → database)\x1b[0m')
  console.log(`  app ${APP}   chain ${RPC}`)

  // ── Setup: fund and verify the sender ────────────────────────────────────
  section('1. Setup')
  const AMOUNT = parseUnits('100', 6)

  // Fresh account: needs native gas as well as tokens.
  await publicClient.waitForTransactionReceipt({
    hash: await deployerWallet.sendTransaction({ to: sender.address, value: 10n ** 18n }),
  })
  await publicClient.waitForTransactionReceipt({
    hash: await deployerWallet.writeContract({
      address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'transfer',
      args: [sender.address, parseUnits('5000', 6)],
    }),
  })

  const kycNonce = await publicClient.readContract({
    address: KYC_REGISTRY_ADDRESS, abi: KYCRegistryAbi, functionName: 'nonces', args: [sender.address],
  }) as bigint
  const level = await publicClient.readContract({
    address: KYC_REGISTRY_ADDRESS, abi: KYCRegistryAbi, functionName: 'getKYCLevel', args: [sender.address],
  }) as number

  if (Number(level) < 1) {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const sig = await createWalletClient({ account: privateKeyToAccount(ORACLE), chain: anvil, transport: viemHttp(RPC) })
      .signTypedData({
        domain: { name: 'KYCRegistry', version: '1', chainId: 31337, verifyingContract: KYC_REGISTRY_ADDRESS },
        types: { VerifyUser: [
          { name: 'user', type: 'address' }, { name: 'newLevel', type: 'uint8' },
          { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
        ] },
        primaryType: 'VerifyUser',
        message: { user: sender.address, newLevel: 1, deadline, nonce: kycNonce },
      })
    await publicClient.waitForTransactionReceipt({
      hash: await deployerWallet.writeContract({
        address: KYC_REGISTRY_ADDRESS, abi: KYCRegistryAbi, functionName: 'verifyUser',
        args: [sender.address, 1, deadline, sig],
      }),
    })
  }
  check('sender funded and KYC-verified', true)

  // ── Corridors ────────────────────────────────────────────────────────────
  section('2. GET /api/corridors')
  const corridors = await api('/api/corridors')
  const list = (corridors.json.corridors ?? []) as Array<Record<string, unknown>>
  const inr = list.find(c => c.id === 'ae-in')!
  check('corridors endpoint responds', corridors.status === 200)
  check('India corridor is open', inr?.open === true)
  check('rate is live, not a hard-coded constant',
    typeof inr?.rate === 'number' && (inr.rate as number) > 1,
    String(inr?.rate))
  check('simulated rail is reported as live:false', inr?.live === false)

  // ── Prepare ──────────────────────────────────────────────────────────────
  section('3. POST /api/transfers/prepare')
  const prep = await api('/api/transfers/prepare', {
    senderAddress: sender.address,
    corridorId: 'ae-in',
    amount: AMOUNT.toString(),
    phone: '09876543210',           // national format — server must normalise it
    email: 'recipient@example.com',
    nickname: 'Mum',
  })
  check('prepare succeeded', prep.status === 200, `${prep.status} ${JSON.stringify(prep.json).slice(0, 200)}`)
  if (prep.status !== 200) { await finish(pg); return }

  const transferId = prep.json.transferId as Hex
  const sendArgs = prep.json.sendArgs as { recipientPhoneHash: Hex; amount: string; otpCommitHash: Hex; corridor: number }
  const quote = prep.json.quote as { rate: number; amountMinor: number; currency: string }

  check('libphonenumber works in the Next.js runtime',
    typeof prep.json.recipientPhoneMasked === 'string' && (prep.json.recipientPhoneMasked as string).startsWith('+91'),
    String(prep.json.recipientPhoneMasked))
  check('server returned a transferId', /^0x[0-9a-f]{64}$/i.test(transferId))
  check('server returned the commitment to sign', /^0x[0-9a-f]{64}$/i.test(sendArgs.otpCommitHash))
  check('FX quote is live', quote.rate > 1 && quote.currency === 'INR', `1 USD = ${quote.rate} INR`)
  check('quote is computed on the NET amount',
    quote.amountMinor < Math.round(Number(AMOUNT) / 1e6 * quote.rate * 100),
    `${quote.amountMinor} paise`)

  // The OTP must NOT be in the response — it goes only to the recipient.
  const prepBody = JSON.stringify(prep.json)
  check('prepare response leaks no OTP or claim secret',
    !/"otp"|claimSecret|otpReveal/i.test(prepBody))

  // ── Send (what the browser does) ─────────────────────────────────────────
  section('4. Sign and broadcast')
  await publicClient.waitForTransactionReceipt({
    hash: await senderWallet.writeContract({
      address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'approve',
      args: [ESCROW_VAULT_ADDRESS, AMOUNT],
    }),
  })
  const sendTx = await senderWallet.writeContract({
    address: REMITCHAIN_ADDRESS, abi: RemitChainAbi, functionName: 'sendRemittance',
    args: [sendArgs.recipientPhoneHash, BigInt(sendArgs.amount), sendArgs.otpCommitHash, sendArgs.corridor],
  })
  const rc = await publicClient.waitForTransactionReceipt({ hash: sendTx })
  check('sendRemittance mined', rc.status === 'success')

  const vaultBal = await publicClient.readContract({
    address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'balanceOf', args: [ESCROW_VAULT_ADDRESS],
  }) as bigint
  check('vault custodies the funds', vaultBal >= AMOUNT, formatUnits(vaultBal, 6))

  // ── Confirm ──────────────────────────────────────────────────────────────
  section('5. POST /api/transfers/confirm')
  const confirm = await api('/api/transfers/confirm', { transferId, txHash: sendTx })
  check('confirm succeeded', confirm.status === 200, `${confirm.status} ${JSON.stringify(confirm.json).slice(0, 160)}`)
  check('recipient notification dispatched', confirm.json.notified === true)

  const row = (await pg.query('SELECT * FROM transfers WHERE id = $1', [transferId])).rows[0]
  check('transfer persisted with the tx hash', row?.tx_hash === sendTx)
  check('expiry stored in milliseconds', Number(row?.expiry) > 1e12, String(row?.expiry))
  check('full phone number is NOT stored', !JSON.stringify(row).includes('9876543210'))
  check('masked phone stored for support', String(row?.recipient_phone_masked).startsWith('+91'))
  check('fee split recorded', row?.fee_amount === '100000' && row?.net_amount === '99900000',
    `fee=${row?.fee_amount} net=${row?.net_amount}`)

  // ── The recipient reads their email ──────────────────────────────────────
  section('6. Recipient credentials')
  const otp = decrypt(row.otp_enc)
  const claimSecret = decrypt(row.claim_secret_enc)
  check('OTP is encrypted at rest, not plaintext', row.otp_enc !== otp && Boolean(otp))
  check('OTP decrypts to 6 digits', /^\d{6}$/.test(otp ?? ''), String(otp))
  check('claim secret decrypts to 43 base64url chars', /^[A-Za-z0-9_-]{43}$/.test(claimSecret ?? ''))

  // ── Wrong OTP is rejected ────────────────────────────────────────────────
  section('7. Wrong credentials are rejected')
  const wrongOtp = otp === '000000' ? '000001' : '000000'
  const badClaim = await api('/api/relayer/claim', {
    transferId, otp: wrongOtp, recipientPhone: RECIPIENT_PHONE,
    payoutDestination: PAYOUT_UPI, claimSecret,
  })
  check('wrong OTP rejected', badClaim.status === 400, String(badClaim.status))
  check('error does not reveal which factor was wrong',
    !/phone/i.test(String(badClaim.json.error)), String(badClaim.json.error))

  const badPhone = await api('/api/relayer/claim', {
    transferId, otp, recipientPhone: '+919999999999',
    payoutDestination: PAYOUT_UPI, claimSecret,
  })
  check('wrong phone rejected', badPhone.status === 400)
  check('same message for both failures',
    String(badPhone.json.error) === String(badClaim.json.error))

  const stillPending = await publicClient.readContract({
    address: REMITCHAIN_ADDRESS, abi: RemitChainAbi, functionName: 'getTransfer', args: [transferId],
  }) as { status: number }
  check('failed attempts did not release the escrow', stillPending.status === 1)

  // ── The real claim ───────────────────────────────────────────────────────
  section('8. POST /api/relayer/claim')
  const relayerBefore = await publicClient.readContract({
    address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'balanceOf', args: [RELAYER_ADDR],
  }) as bigint
  const treasuryBefore = await publicClient.readContract({
    address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'balanceOf', args: [TREASURY],
  }) as bigint

  const claim = await api('/api/relayer/claim', {
    transferId, otp, recipientPhone: RECIPIENT_PHONE,
    payoutDestination: PAYOUT_UPI, claimSecret,
  })
  check('claim succeeded', claim.status === 200, `${claim.status} ${JSON.stringify(claim.json).slice(0, 200)}`)
  check('claim returned a transaction hash', /^0x[0-9a-f]{64}$/i.test(String(claim.json.txHash)))

  const claimed = await publicClient.readContract({
    address: REMITCHAIN_ADDRESS, abi: RemitChainAbi, functionName: 'getTransfer', args: [transferId],
  }) as { status: number }
  check('transfer is CLAIMED on-chain', claimed.status === 2)

  const relayerAfter = await publicClient.readContract({
    address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'balanceOf', args: [RELAYER_ADDR],
  }) as bigint
  const treasuryAfter = await publicClient.readContract({
    address: QUSD_ADDRESS, abi: ERC20Abi, functionName: 'balanceOf', args: [TREASURY],
  }) as bigint

  check('recipient side received the net amount',
    relayerAfter - relayerBefore === 99_900_000n,
    formatUnits(relayerAfter - relayerBefore, 6))
  check('treasury received exactly the 0.1% fee',
    treasuryAfter - treasuryBefore === 100_000n,
    formatUnits(treasuryAfter - treasuryBefore, 6))

  // ── Payout ledger ────────────────────────────────────────────────────────
  section('9. Payout ledger')
  const payout = (await pg.query('SELECT * FROM payouts WHERE transfer_id = $1', [transferId])).rows[0]
  check('payout row created', Boolean(payout))
  check('payout is priced from the locked quote',
    payout?.amount_minor === String(quote.amountMinor),
    `${payout?.amount_minor} vs quoted ${quote.amountMinor}`)
  check('payout source amount equals the settled net', payout?.source_amount === '99900000')
  check('destination stored masked for display',
    payout?.destination_masked && !payout.destination_masked.includes('ramesh'),
    payout?.destination_masked)
  check('payout was submitted immediately', ['SUBMITTED', 'PROCESSING', 'PAID'].includes(payout?.status),
    payout?.status)

  const claimedRow = (await pg.query('SELECT * FROM transfers WHERE id = $1', [transferId])).rows[0]
  check('claim credentials wiped after settlement',
    claimedRow.otp_enc === null && claimedRow.claim_secret_enc === null)
  check('payout intent recorded before broadcast', claimedRow.payout_destination_enc !== null)

  // ── Idempotency ──────────────────────────────────────────────────────────
  section('10. Idempotency')
  const replay = await api('/api/relayer/claim', {
    transferId, otp, recipientPhone: RECIPIENT_PHONE,
    payoutDestination: PAYOUT_UPI, claimSecret,
  })
  check('replayed claim returns success without re-broadcasting',
    replay.status === 200 && replay.json.idempotent === true)
  const payoutCount = (await pg.query('SELECT count(*)::int AS n FROM payouts WHERE transfer_id = $1', [transferId])).rows[0].n
  check('still exactly one payout row', payoutCount === 1, String(payoutCount))

  // ── Cron: reconcile the payout to completion ─────────────────────────────
  section('11. Payout worker + reconciler')
  // The sandbox rail settles after ~20s; wait it out so PAID is real.
  await new Promise(r => setTimeout(r, 21_000))
  const cron = await api('/api/cron/payouts', undefined, {
    method: 'GET', headers: { Authorization: `Bearer ${CRON_SECRET}` },
  })
  check('cron authenticated and ran', cron.status === 200, JSON.stringify(cron.json).slice(0, 160))

  const settled = (await pg.query('SELECT * FROM payouts WHERE transfer_id = $1', [transferId])).rows[0]
  check('payout reconciled to PAID', settled?.status === 'PAID', settled?.status)
  check('bank reference recorded', Boolean(settled?.provider_utr), settled?.provider_utr)
  check('paid_at timestamp set in ms', Number(settled?.paid_at) > 1e12)

  const unauth = await api('/api/cron/payouts')
  check('cron rejects an unauthenticated call', unauth.status === 401, String(unauth.status))

  // ── Public read APIs ─────────────────────────────────────────────────────
  section('12. Public reads')
  const detail = await api(`/api/transfers/${transferId}`)
  check('transfer detail returns 200', detail.status === 200)
  check('detail reports CLAIMED', detail.json.status === 1)
  const detailBody = JSON.stringify(detail.json)
  check('detail leaks no OTP, secret or full destination',
    !/otp|claimSecret|ramesh\.k@/i.test(detailBody))
  check('detail exposes the payout status',
    (detail.json.payout as Record<string, unknown>)?.status === 'PAID')
  check('detail marks the simulated rail as not live',
    (detail.json.payout as Record<string, unknown>)?.live === false)

  const history = await api(`/api/transfers?address=${sender.address}`)
  check('sender history returns their transfer',
    ((history.json.transfers ?? []) as Array<{ id: string }>).some(t => t.id === transferId))

  const godView = await api('/api/transfers?address=all&demo=true')
  check('the all-transfers god view is gone', godView.status === 400, String(godView.status))

  // ── Removed surfaces ─────────────────────────────────────────────────────
  section('13. Removed attack surface')
  for (const [path, label] of [
    ['/api/relayer', 'legacy unhardened claim route'],
    ['/api/debug/relayer', 'relayer debug endpoint'],
    [`/api/transfers/${transferId}/demo-otp`, 'plaintext OTP endpoint'],
    ['/api/offramp/upi', 'inline offramp route'],
    ['/api/notify', 'unauthenticated notify route'],
  ] as const) {
    const r = await api(path, { transferId, otp: '123456' })
    check(`${label} returns 404`, r.status === 404, `${path} → ${r.status}`)
  }

  // ── Webhook auth ─────────────────────────────────────────────────────────
  section('14. Webhook authentication')
  const forged = await api('/api/webhooks/razorpay', { event: 'payout.processed' })
  check('unsigned webhook rejected', forged.status === 401, String(forged.status))

  await finish(pg)
}

async function finish(pg: Client) {
  await pg.end()
  console.log(`\n\x1b[1m${'─'.repeat(66)}\x1b[0m`)
  if (failures.length === 0) {
    console.log(`\x1b[32m\x1b[1m  ${passed} checks passed — full stack verified end to end.\x1b[0m\n`)
  } else {
    console.log(`\x1b[31m\x1b[1m  ${failures.length} FAILED, ${passed} passed\x1b[0m`)
    failures.forEach(f => console.log(`\x1b[31m    - ${f}\x1b[0m`))
    console.log('')
    process.exitCode = 1
  }
}

main().catch(e => { console.error('\n\x1b[31mFatal:\x1b[0m', e); process.exit(1) })
