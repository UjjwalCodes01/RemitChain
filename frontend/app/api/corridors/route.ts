/**
 * GET /api/corridors
 *
 * Which destinations can actually be sent to right now, and at what rate.
 *
 * The send page renders from this rather than from a hard-coded list, so a
 * corridor whose payout provider is unavailable simply cannot be selected.
 * The old client had all five corridors compiled in with hard-coded FX rates,
 * four of which had no working payout rail at all.
 */

import { NextResponse } from 'next/server'
import { IS_PRODUCTION_CHAIN } from '@/lib/env'
import { CORRIDORS, resolveProviderId } from '@/lib/corridors'
import { getProvider } from '@/lib/payouts/registry'
import { getFxRate } from '@/lib/fx/rates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const results = await Promise.all(
    CORRIDORS.map(async corridor => {
      const providerId = resolveProviderId(corridor, IS_PRODUCTION_CHAIN)
      const provider = providerId ? getProvider(providerId) : null
      const fx = await getFxRate(corridor.currency)

      // A corridor is only sendable if it has a provider AND we hold a rate
      // within the staleness bound. `getFxRate` returns null otherwise.
      const open = providerId !== null && fx !== null

      return {
        id: corridor.id,
        index: corridor.index,
        label: corridor.label,
        flags: corridor.flags,
        rail: corridor.rail,
        currency: corridor.currency,
        symbol: corridor.currencySymbol,
        minorUnits: corridor.minorUnits,
        destinationLabel: corridor.destinationLabel,
        destinationPlaceholder: corridor.destinationPlaceholder,
        destinationHint: corridor.destinationHint,
        recvCountry: corridor.recvCountry,
        open,
        // `live: false` means a simulated rail. The UI must say so plainly.
        live: provider?.isLive ?? false,
        rate: fx?.rate ?? null,
        rateSource: fx?.source ?? null,
        rateAgeMs: fx?.ageMs ?? null,
        closedReason: open
          ? undefined
          : !providerId
            ? `${corridor.rail} payouts are not available yet`
            : 'Exchange rates are temporarily unavailable',
      }
    }),
  )

  return NextResponse.json(
    { corridors: results, productionChain: IS_PRODUCTION_CHAIN },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
