/**
 * lib/payouts/providers/razorpay.ts
 *
 * RazorpayX Payouts — the live UPI rail for the AE→IN corridor.
 *
 * Flow (three calls, first two cached):
 *   1. POST /v1/contacts        → contact_id     (the beneficiary person)
 *   2. POST /v1/fund_accounts   → fund_account_id (their UPI VPA)
 *   3. POST /v1/payouts         → payout_id       (the money movement)
 *
 * Steps 1–2 are stable per destination, so `fund_account_id` is persisted on
 * the payout row and reused by every retry. Step 3 carries the
 * `X-Payout-Idempotency` header, which is what makes a retry safe: Razorpay
 * returns the ORIGINAL payout rather than creating a second one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED FROM THE PREVIOUS IMPLEMENTATION
 * ─────────────────────────────────────────────────────────────────────────────
 *  - It no longer treats an `rzp_test_` key as "pretend the payout succeeded".
 *    That branch reported COMPLETED to the user while moving nothing.
 *  - It no longer swallows a non-OK fund-account response (`faRes.status !== 400`
 *    was accepted as success, then `fa.id ?? 'fa_<slice>'` fabricated an id and
 *    posted a payout against an account that did not exist).
 *  - `account_number` no longer falls back to the literal string `'test_account'`.
 *  - Errors are now classified: retryable vs permanent vs ambiguous, so the
 *    worker knows whether re-submitting is safe.
 *
 * Docs: https://razorpay.com/docs/api/x/
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  PayoutProvider,
  CreatePayoutRequest,
  ProviderPayoutResult,
  PayoutStatus,
  WebhookVerification,
} from '../types'
import {
  RetryablePayoutError,
  PermanentPayoutError,
  AmbiguousPayoutError,
} from '../types'

const API = 'https://api.razorpay.com/v1'
const TIMEOUT_MS = 20_000

// ─── Status mapping ──────────────────────────────────────────────────────────

/**
 * RazorpayX payout states → our ledger states.
 * https://razorpay.com/docs/api/x/payouts/#payout-states
 */
function mapStatus(raw: string): PayoutStatus {
  switch (raw) {
    case 'processed':
      return 'PAID'
    case 'queued':
    case 'pending':
    case 'scheduled':
    case 'processing':
      return 'PROCESSING'
    case 'reversed':
      return 'REVERSED'
    case 'cancelled':
    case 'rejected':
    case 'failed':
      return 'FAILED'
    default:
      // An unrecognised state must not be guessed at when money is involved.
      return 'MANUAL_REVIEW'
  }
}

// ─── HTTP plumbing ───────────────────────────────────────────────────────────

interface RazorpayError {
  error?: { code?: string; description?: string; reason?: string }
}

function authHeader(): string {
  const keyId = process.env.RAZORPAY_KEY_ID
  const keySecret = process.env.RAZORPAY_KEY_SECRET
  if (!keyId || !keySecret) {
    throw new PermanentPayoutError('Razorpay credentials are not configured')
  }
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`
}

function accountNumber(): string {
  const acct = process.env.RAZORPAY_ACCOUNT_NUMBER
  if (!acct) {
    // Previously this silently defaulted to the string 'test_account', which
    // makes every payout fail in a way that looks like a Razorpay outage.
    throw new PermanentPayoutError(
      'RAZORPAY_ACCOUNT_NUMBER is not set — this is your RazorpayX virtual account number',
    )
  }
  return acct
}

interface RequestOptions {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  idempotencyKey?: string
}

async function call<T>(opts: RequestOptions): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: authHeader(),
    'Content-Type': 'application/json',
  }
  if (opts.idempotencyKey) headers['X-Payout-Idempotency'] = opts.idempotencyKey

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(`${API}${opts.path}`, {
      method: opts.method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    })
  } catch (err) {
    // A timeout or connection reset on a POST means the request may or may not
    // have been processed. It is still safe to retry BECAUSE of the idempotency
    // header — Razorpay will return the original payout rather than making a
    // second one.
    throw new RetryablePayoutError(
      `Razorpay ${opts.method} ${opts.path} did not complete: ${String(err)}`,
      err,
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()

  if (res.ok) {
    try {
      return JSON.parse(text) as T
    } catch (err) {
      throw new AmbiguousPayoutError(
        `Razorpay returned HTTP ${res.status} with an unparseable body`,
        err,
      )
    }
  }

  let parsed: RazorpayError = {}
  try {
    parsed = JSON.parse(text) as RazorpayError
  } catch {
    /* keep the raw text below */
  }
  const description = parsed.error?.description ?? text.slice(0, 300)
  const code = parsed.error?.code ?? String(res.status)
  const message = `Razorpay ${opts.path} failed [${code}]: ${description}`

  // 5xx and 429 are transient.
  if (res.status >= 500 || res.status === 429) {
    throw new RetryablePayoutError(message)
  }

  // 4xx is a request we should not repeat unchanged. Insufficient balance is
  // the exception: it is a 4xx that resolves once the account is topped up.
  if (/insufficient|balance/i.test(description)) {
    throw new RetryablePayoutError(message)
  }

  throw new PermanentPayoutError(message)
}

// ─── Beneficiary setup ───────────────────────────────────────────────────────

interface ContactResponse { id: string }
interface FundAccountResponse { id: string; active?: boolean }

/**
 * Create (or reuse) a fund account for a UPI VPA.
 * `reference_id` is derived from the transfer so the records are traceable in
 * the Razorpay dashboard.
 */
async function ensureFundAccount(req: CreatePayoutRequest): Promise<string> {
  if (req.existingAccountRef) return req.existingAccountRef

  const reference = req.transferId.slice(2, 22)

  const contact = await call<ContactResponse>({
    method: 'POST',
    path: '/contacts',
    body: {
      name: 'RemitChain Recipient',
      type: 'customer',
      reference_id: `rc_${reference}`,
      notes: { transfer_id: req.transferId },
    },
  })

  if (!contact.id) {
    throw new PermanentPayoutError('Razorpay contact creation returned no id')
  }

  const fundAccount = await call<FundAccountResponse>({
    method: 'POST',
    path: '/fund_accounts',
    body: {
      contact_id: contact.id,
      account_type: 'vpa',
      vpa: { address: req.destination },
    },
  })

  if (!fundAccount.id) {
    throw new PermanentPayoutError('Razorpay fund account creation returned no id')
  }
  if (fundAccount.active === false) {
    throw new PermanentPayoutError(
      `Razorpay reports the UPI address ${req.destination} as inactive or invalid`,
    )
  }

  return fundAccount.id
}

// ─── Payout ──────────────────────────────────────────────────────────────────

interface PayoutResponse {
  id: string
  status: string
  utr?: string | null
  failure_reason?: string | null
}

function toResult(p: PayoutResponse, accountRef?: string): ProviderPayoutResult {
  return {
    providerRef: p.id,
    providerStatus: p.status,
    status: mapStatus(p.status),
    utr: p.utr ?? undefined,
    providerAccountRef: accountRef,
  }
}

export const razorpayProvider: PayoutProvider = {
  id: 'razorpay',
  isLive: true,

  async createPayout(req: CreatePayoutRequest): Promise<ProviderPayoutResult> {
    if (req.currency !== 'INR') {
      throw new PermanentPayoutError(`RazorpayX payouts are INR-only, got ${req.currency}`)
    }
    if (!Number.isInteger(req.amountMinor) || req.amountMinor <= 0) {
      throw new PermanentPayoutError(`Invalid payout amount: ${req.amountMinor} paise`)
    }

    const fundAccountId = await ensureFundAccount(req)

    const payout = await call<PayoutResponse>({
      method: 'POST',
      path: '/payouts',
      idempotencyKey: req.idempotencyKey,
      body: {
        account_number: accountNumber(),
        fund_account_id: fundAccountId,
        amount: req.amountMinor,
        currency: 'INR',
        mode: 'UPI',
        purpose: 'payout',
        // Never let Razorpay silently hold a payout when the account is short —
        // we would report PROCESSING indefinitely. Fail fast and retry.
        queue_if_low_balance: false,
        reference_id: req.transferId.slice(2, 22),
        narration: req.narration.slice(0, 30), // Razorpay caps narration at 30 chars
        notes: { transfer_id: req.transferId },
      },
    })

    if (!payout.id) {
      throw new AmbiguousPayoutError('Razorpay accepted the payout but returned no id')
    }

    return toResult(payout, fundAccountId)
  },

  async getPayout(providerRef: string): Promise<ProviderPayoutResult> {
    const payout = await call<PayoutResponse>({
      method: 'GET',
      path: `/payouts/${encodeURIComponent(providerRef)}`,
    })
    return toResult(payout)
  },

  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET
    if (!secret) {
      return { ok: false, error: 'RAZORPAY_WEBHOOK_SECRET is not configured' }
    }

    const signature = headers.get('x-razorpay-signature')
    if (!signature) {
      return { ok: false, error: 'Missing X-Razorpay-Signature header' }
    }

    // Signature is HMAC-SHA256 of the RAW body. Re-serialising parsed JSON
    // would change the byte sequence and never match.
    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
    const sigBuf = Buffer.from(signature, 'utf8')
    const expBuf = Buffer.from(expected, 'utf8')
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return { ok: false, error: 'Webhook signature mismatch' }
    }

    let event: {
      event?: string
      // Razorpay does not put an id in the body; the header carries it.
      payload?: { payout?: { entity?: PayoutResponse } }
      created_at?: number
    }
    try {
      event = JSON.parse(rawBody)
    } catch {
      return { ok: false, error: 'Webhook body is not valid JSON' }
    }

    const entity = event.payload?.payout?.entity
    if (!entity?.id) {
      // Not a payout event (could be a transaction or account event). Verified,
      // but nothing for us to act on.
      return { ok: true, eventType: event.event ?? 'unknown', eventId: headers.get('x-razorpay-event-id') ?? undefined }
    }

    return {
      ok: true,
      // Razorpay sends a unique delivery id per event in this header.
      // Fall back to a deterministic composite so de-duplication still works.
      eventId:
        headers.get('x-razorpay-event-id') ??
        `${entity.id}:${event.event ?? 'unknown'}:${event.created_at ?? 0}`,
      eventType: event.event ?? 'unknown',
      providerRef: entity.id,
      status: mapStatus(entity.status),
      providerStatus: entity.status,
      utr: entity.utr ?? undefined,
    }
  },
}
