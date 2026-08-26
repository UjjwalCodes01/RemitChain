/**
 * lib/payouts/providers/sandbox.ts
 *
 * A simulated payout rail for testnet and local development.
 *
 * It exists so the whole pipeline — ledger, state machine, retries, webhook
 * handling, reconciliation, UI — can be exercised end to end without a
 * provider account. It is NOT a stand-in for a real rail:
 *
 *   - `isLive` is false, and the UI shows a simulated-payout notice wherever a
 *     payout backed by this provider appears.
 *   - `isProviderConfigured` refuses to enable it on a production chain, and
 *     `assertPayoutConfigSafe()` refuses to boot if that is somehow bypassed.
 *
 * This replaces the old inline stub, which returned
 * `offrampStatus: 'COMPLETED'` with a fabricated reference and was
 * indistinguishable from a real payout in the database, the API and the UI.
 */

import { createHash } from 'node:crypto'
import type {
  PayoutProvider,
  CreatePayoutRequest,
  ProviderPayoutResult,
  WebhookVerification,
} from '../types'
import { PermanentPayoutError } from '../types'

/** Deterministic pseudo-reference so retries produce a stable id. */
function refFor(idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 14)
  return `sbx_${digest}`
}

/**
 * Settlement delay, so the UI genuinely passes through PROCESSING rather than
 * jumping straight to PAID and hiding bugs in the in-flight states.
 */
const SETTLE_AFTER_MS = 20_000

const submittedAt = new Map<string, number>()

export const sandboxProvider: PayoutProvider = {
  id: 'sandbox',
  isLive: false,

  async createPayout(req: CreatePayoutRequest): Promise<ProviderPayoutResult> {
    if (!Number.isInteger(req.amountMinor) || req.amountMinor <= 0) {
      throw new PermanentPayoutError(`Invalid payout amount: ${req.amountMinor}`)
    }

    const ref = refFor(req.idempotencyKey)
    if (!submittedAt.has(ref)) submittedAt.set(ref, Date.now())

    // A reserved destination that lets tests drive the failure path.
    if (req.destination.startsWith('fail@')) {
      return { providerRef: ref, providerStatus: 'failed', status: 'FAILED' }
    }

    return { providerRef: ref, providerStatus: 'processing', status: 'PROCESSING' }
  },

  async getPayout(providerRef: string): Promise<ProviderPayoutResult> {
    const started = submittedAt.get(providerRef)
    // Serverless instances are ephemeral, so an unknown ref simply means this
    // instance never saw the submit. Treat it as settled — the ref is
    // deterministic, so it can only exist if we created it.
    const settled = started === undefined || Date.now() - started > SETTLE_AFTER_MS

    return settled
      ? {
          providerRef,
          providerStatus: 'processed',
          status: 'PAID',
          utr: `SBX${providerRef.slice(4, 16).toUpperCase()}`,
        }
      : { providerRef, providerStatus: 'processing', status: 'PROCESSING' }
  },

  verifyWebhook(): WebhookVerification {
    // The sandbox settles by reconciliation polling, not webhooks.
    return { ok: false, error: 'The sandbox provider does not send webhooks' }
  },
}
