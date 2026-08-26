import { IS_PRODUCTION_CHAIN } from '@/lib/env'
import { CORRIDORS, resolveProviderId } from '@/lib/corridors'
import { getProvider } from '@/lib/payouts/registry'

/**
 * Corridor availability on the landing page.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS USED TO CLAIM
 * ─────────────────────────────────────────────────────────────────────────────
 * A hard-coded list of six corridors, each with an unsourced "old fee" struck
 * through next to ours:
 *
 *     UAE→India 3.8% · USA→Mexico 3.1% · UK→Nigeria 5.8%
 *     Saudi→Pakistan 4.9% · Singapore→Bangladesh 5.1% · UK→Philippines 4.2%
 *
 * Three problems. The per-corridor competitor rates were invented — no source,
 * no provider, no date. UK→Philippines/GCash was advertised but does not exist
 * anywhere in the system. And all six were presented as available when only one
 * has a working payout rail.
 *
 * This is now derived from the same corridor table the send page and the API
 * use, so the landing page cannot advertise something the product will refuse
 * to do. A corridor with no live payout provider is shown as "Coming soon"
 * rather than silently listed as available.
 */

export function CorridorStrip() {
  const corridors = CORRIDORS.map(c => {
    const providerId = resolveProviderId(c, IS_PRODUCTION_CHAIN)
    const provider = providerId ? getProvider(providerId) : null
    return { ...c, live: Boolean(providerId) && (provider?.isLive ?? false) }
  })

  return (
    <div className="overflow-x-auto pb-2 -mx-4 px-4">
      <div className="flex gap-3 min-w-max mx-auto justify-center flex-wrap">
        {corridors.map(c => (
          <div
            key={c.id}
            className="flex items-center gap-3 rounded-xl px-4 py-3 border shrink-0"
            style={{
              background: 'var(--color-surface)',
              borderColor: c.live ? 'var(--color-mint-glow)' : 'var(--color-border)',
              opacity: c.live ? 1 : 0.6,
            }}
          >
            <span className="text-xl leading-none" aria-label={`${c.sendCountry} to ${c.recvCountry}`}>
              {c.flags}
            </span>

            <div className="flex flex-col">
              <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
                {c.label}
              </span>
              <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                {c.live ? `${c.rail} · 0.1% fee` : `${c.rail} · Coming soon`}
              </span>
            </div>

            {c.live && (
              <span
                className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md"
                style={{ background: 'var(--color-mint-dim)', color: 'var(--color-mint)' }}
              >
                Live
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
