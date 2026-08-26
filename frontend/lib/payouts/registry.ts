/**
 * lib/payouts/registry.ts
 *
 * Provider lookup and the boot-time safety check.
 */

import type { ProviderId } from '@/lib/corridors'
import { CORRIDORS, isProviderConfigured, resolveProviderId } from '@/lib/corridors'
import type { PayoutProvider } from './types'
import { razorpayProvider } from './providers/razorpay'
import { sandboxProvider } from './providers/sandbox'

const PROVIDERS: Record<ProviderId, PayoutProvider> = {
  razorpay: razorpayProvider,
  sandbox: sandboxProvider,
}

export function getProvider(id: string): PayoutProvider | null {
  return PROVIDERS[id as ProviderId] ?? null
}

/**
 * A payout row written before this refactor carries `provider = 'legacy'`.
 * There is no implementation for it — those rows are MANUAL_REVIEW only.
 */
export function isLegacyProvider(id: string): boolean {
  return id === 'legacy'
}

/**
 * Fail fast at boot if the payout configuration could move money in a way the
 * operator did not intend.
 *
 * Called from lib/env.ts, so a misconfigured deployment cannot start.
 */
export function assertPayoutConfigSafe(isProductionChain: boolean): void {
  if (!isProductionChain) return

  // Simulated payouts on a production chain would report success to a real
  // user whose real funds have already left escrow.
  if (process.env.ENABLE_SANDBOX_PAYOUTS === 'true') {
    throw new Error(
      'FATAL: ENABLE_SANDBOX_PAYOUTS=true on a production chain. Simulated payouts ' +
      'would report success to users whose funds have actually left escrow. ' +
      'Unset it, or point NEXT_PUBLIC_CHAIN_ID at a testnet.',
    )
  }

  // A test-mode Razorpay key on mainnet is the same trap in a different shape.
  const keyId = process.env.RAZORPAY_KEY_ID
  if (keyId && !keyId.startsWith('rzp_live_')) {
    throw new Error(
      `FATAL: RAZORPAY_KEY_ID is "${keyId.slice(0, 12)}…", which is not a live key, ` +
      'but the app is pointed at a production chain. Use a rzp_live_ key or move to testnet.',
    )
  }

  // Live payouts without a webhook secret means no authoritative settlement
  // signal — payouts would sit in PROCESSING until the reconciler times them
  // out into MANUAL_REVIEW.
  if (isProviderConfigured('razorpay', true) && !process.env.RAZORPAY_WEBHOOK_SECRET) {
    throw new Error(
      'FATAL: Razorpay is configured for live payouts but RAZORPAY_WEBHOOK_SECRET is unset. ' +
      'Without it, settlement confirmations cannot be verified.',
    )
  }
}

/** Human-readable corridor readiness, surfaced by /api/health. */
export interface CorridorReadiness {
  corridor: string
  rail: string
  currency: string
  open: boolean
  provider: ProviderId | null
  live: boolean
  reason?: string
}

export function describeCorridorReadiness(isProductionChain: boolean): CorridorReadiness[] {
  return CORRIDORS.map(c => {
    const providerId = resolveProviderId(c, isProductionChain)
    const provider = providerId ? getProvider(providerId) : null
    return {
      corridor: c.id,
      rail: c.rail,
      currency: c.currency,
      open: providerId !== null,
      provider: providerId,
      live: provider?.isLive ?? false,
      reason: providerId
        ? undefined
        : c.providers.length === 0
          ? `No payout provider is implemented for ${c.rail}`
          : `Credentials missing for: ${c.providers.join(', ')}`,
    }
  })
}
