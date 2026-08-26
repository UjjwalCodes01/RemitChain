#!/usr/bin/env tsx
/**
 * scripts/preflight.ts
 *
 * Go / no-go check for a deployment. Run it against production before you tell
 * anyone the service is open.
 *
 * It replaces the manual checklist in LAUNCH.md §7 — reading a JSON health
 * response and eyeballing whether each field looks right is exactly the kind of
 * check that gets skipped at the end of a long day.
 *
 * Everything here is read-only. It moves no money and writes nothing.
 *
 * Usage:
 *   pnpm preflight                                  # checks localhost
 *   PREFLIGHT_URL=https://your-domain.com pnpm preflight
 */

import { createPublicClient, http, formatEther, type Hex } from 'viem'

const APP = (process.env.PREFLIGHT_URL ?? 'http://localhost:3000').replace(/\/$/, '')

type Level = 'BLOCK' | 'WARN' | 'OK'
interface Finding { level: Level; label: string; detail?: string }

const findings: Finding[] = []
const ok = (label: string, detail?: string) => findings.push({ level: 'OK', label, detail })
const warn = (label: string, detail?: string) => findings.push({ level: 'WARN', label, detail })
const block = (label: string, detail?: string) => findings.push({ level: 'BLOCK', label, detail })

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

function render(from: number) {
  for (const f of findings.slice(from)) {
    const mark = f.level === 'OK' ? '\x1b[32m✓\x1b[0m'
      : f.level === 'WARN' ? '\x1b[33m!\x1b[0m'
      : '\x1b[31m✗\x1b[0m'
    console.log(`  ${mark} ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  }
}

interface HealthResponse {
  status: string
  chainId: number
  productionChain: boolean
  services: Record<string, string>
  corridors: Array<{ corridor: string; rail: string; open: boolean; live: boolean; reason?: string }>
  summary: { corridorsOpen: number; corridorsLive: number; canAcceptTransfers: boolean; canSettle: boolean }
}

async function main() {
  console.log(`\n\x1b[1mRemitChain preflight\x1b[0m\n  target ${APP}`)

  // ── Health ───────────────────────────────────────────────────────────────
  section('Service health')
  let mark = findings.length
  let health: HealthResponse

  try {
    const res = await fetch(`${APP}/api/health`, { cache: 'no-store' })
    health = await res.json() as HealthResponse
    if (res.status === 200 && health.status === 'ok') ok('health endpoint reports ok')
    else block(`health reports "${health.status}"`, `HTTP ${res.status}`)
  } catch (err) {
    block('health endpoint unreachable', String(err).slice(0, 120))
    render(mark)
    return summarise()
  }

  for (const [service, state] of Object.entries(health.services)) {
    if (state.startsWith('MISSING')) block(`${service}: ${state}`)
    else if (state.startsWith('missing')) warn(`${service}: ${state}`)
    else ok(`${service}: ${state}`)
  }
  render(mark)

  // ── Chain ────────────────────────────────────────────────────────────────
  section('Chain')
  mark = findings.length

  if (health.productionChain) ok(`targeting production chain ${health.chainId}`)
  else warn(`targeting NON-production chain ${health.chainId}`, 'no real value at stake')
  render(mark)

  // ── Corridors ────────────────────────────────────────────────────────────
  section('Corridors')
  mark = findings.length

  if (health.summary.corridorsLive === 0) {
    block('no corridor has a live payout rail', 'nobody can actually be paid')
  } else {
    ok(`${health.summary.corridorsLive} corridor(s) with a live payout rail`)
  }

  for (const c of health.corridors) {
    if (c.open && !c.live) {
      // A simulated rail on production is refused at boot, so this can only be
      // a non-production deployment — but say so plainly either way.
      warn(`${c.corridor} (${c.rail}) is open on a SIMULATED rail`, 'no real money will move')
    } else if (c.open) {
      ok(`${c.corridor} (${c.rail}) live`)
    }
  }
  render(mark)

  // ── Relayer ──────────────────────────────────────────────────────────────
  section('Relayer')
  mark = findings.length

  const rpc = process.env.NEXT_PUBLIC_RPC_URL
  const relayer = process.env.NEXT_PUBLIC_RELAYER_ADDRESS as Hex | undefined

  if (!rpc || !relayer) {
    warn('relayer balance not checked', 'set NEXT_PUBLIC_RPC_URL and NEXT_PUBLIC_RELAYER_ADDRESS locally')
  } else {
    try {
      const client = createPublicClient({ transport: http(rpc) })
      const balance = await client.getBalance({ address: relayer })
      const asEther = Number(formatEther(balance))
      // The claim route refuses below 0.01. Warn well before that, because a
      // relayer that runs dry stops every claim at once.
      if (asEther < 0.05) block(`relayer gas critically low: ${asEther} QIE`, 'claims will start failing')
      else if (asEther < 0.5) warn(`relayer gas low: ${asEther} QIE`, 'top up soon')
      else ok(`relayer holds ${asEther} QIE for gas`)
    } catch (err) {
      warn('could not read the relayer balance', String(err).slice(0, 100))
    }
  }
  render(mark)

  // ── Scheduled jobs ───────────────────────────────────────────────────────
  section('Scheduled jobs')
  mark = findings.length

  try {
    const res = await fetch(`${APP}/api/cron/payouts`, { cache: 'no-store' })
    if (res.status === 401) ok('payout cron rejects unauthenticated calls')
    else if (res.status === 200) block('payout cron is UNAUTHENTICATED', 'anyone can trigger it')
    else warn(`payout cron returned ${res.status}`)
  } catch (err) {
    warn('could not reach the payout cron', String(err).slice(0, 100))
  }
  render(mark)

  // ── Operations ───────────────────────────────────────────────────────────
  section('Operations')
  mark = findings.length

  try {
    const res = await fetch(`${APP}/api/ops/payouts`, { cache: 'no-store' })
    if (res.status === 401) ok('manual review queue is protected')
    else if (res.status === 200) block('manual review queue is UNAUTHENTICATED', 'it can settle payouts')
    else warn(`ops queue returned ${res.status}`)
  } catch {
    warn('could not reach the ops queue')
  }
  render(mark)

  // ── Removed surfaces ─────────────────────────────────────────────────────
  section('Retired endpoints')
  mark = findings.length

  for (const path of [
    '/api/relayer',
    '/api/debug/relayer',
    '/api/notify',
    '/api/offramp/upi',
  ]) {
    try {
      const res = await fetch(`${APP}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (res.status === 404) ok(`${path} is gone`)
      else block(`${path} still responds`, `HTTP ${res.status}`)
    } catch {
      ok(`${path} is gone`)
    }
  }
  render(mark)

  // ── Cutover flag ─────────────────────────────────────────────────────────
  section('Cutover')
  mark = findings.length

  const legacy = process.env.ALLOW_LEGACY_OTP_SCHEME
  if (!legacy) {
    ok('legacy OTP scheme is disabled')
  } else if (legacy === 'true') {
    block('ALLOW_LEGACY_OTP_SCHEME=true has no expiry', 'set an ISO-8601 deadline instead')
  } else {
    const expiry = Date.parse(legacy)
    if (Number.isNaN(expiry)) {
      block(`ALLOW_LEGACY_OTP_SCHEME="${legacy}" is not a valid timestamp`)
    } else if (expiry < Date.now()) {
      ok('legacy OTP window has expired', 'safe to remove the variable')
    } else {
      warn(`legacy OTP window closes in ${Math.round((expiry - Date.now()) / 3.6e6)}h`,
        'the pre-upgrade commitment is accepted until then')
    }
  }
  render(mark)

  summarise()
}

function summarise() {
  const blocks = findings.filter(f => f.level === 'BLOCK')
  const warns = findings.filter(f => f.level === 'WARN')

  console.log(`\n\x1b[1m${'─'.repeat(66)}\x1b[0m`)
  if (blocks.length > 0) {
    console.log(`\x1b[31m\x1b[1m  NO-GO — ${blocks.length} blocking issue(s)\x1b[0m`)
    blocks.forEach(f => console.log(`\x1b[31m    ✗ ${f.label}\x1b[0m`))
    if (warns.length) console.log(`\x1b[33m  plus ${warns.length} warning(s)\x1b[0m`)
    process.exitCode = 1
  } else if (warns.length > 0) {
    console.log(`\x1b[33m\x1b[1m  GO, with ${warns.length} warning(s) — read them before you announce\x1b[0m`)
    warns.forEach(f => console.log(`\x1b[33m    ! ${f.label}\x1b[0m`))
  } else {
    console.log(`\x1b[32m\x1b[1m  GO — every check passed\x1b[0m`)
  }
  console.log('')
}

main().catch(e => {
  console.error('\n\x1b[31mPreflight failed:\x1b[0m', e)
  process.exit(1)
})
