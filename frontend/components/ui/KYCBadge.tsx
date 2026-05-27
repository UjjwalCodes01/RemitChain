import type { KYCTier } from '@/hooks/useKYCStatus'

interface KYCBadgeProps {
  tier: KYCTier
  isLoading?: boolean
  showUpgradeCTA?: boolean
  onUpgrade?: () => void
}

const TIER_CONFIG = {
  0: {
    label: 'Unverified',
    icon: '○',
    colorClass: 'text-[var(--color-text-tertiary)] bg-[var(--color-surface-elevated)] border-[var(--color-border)]',
    limit: null,
  },
  1: {
    label: 'Phone Verified',
    icon: '◑',
    colorClass: 'text-[var(--color-warning)] bg-amber-500/10 border-amber-500/20',
    limit: '$500/day',
  },
  2: {
    label: 'Full ID',
    icon: '●',
    colorClass: 'text-[var(--color-mint)] bg-[var(--color-mint-dim)] border-[var(--color-mint-glow)]',
    limit: '$5,000/day',
  },
} as const

export function KYCBadge({ tier, isLoading = false, showUpgradeCTA = false, onUpgrade }: KYCBadgeProps) {
  if (isLoading) {
    return (
      <div className="h-7 w-32 skeleton rounded-full" aria-label="Loading KYC status" />
    )
  }

  const config = TIER_CONFIG[tier]

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span
        className={`
          inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-xs font-medium
          border ${config.colorClass}
        `}
        aria-label={`KYC status: ${config.label}`}
      >
        <span aria-hidden>{config.icon}</span>
        {config.label}
        {config.limit && (
          <span className="opacity-60 ml-1">· {config.limit}</span>
        )}
      </span>

      {showUpgradeCTA && tier < 2 && (
        <button
          onClick={onUpgrade}
          className="
            text-xs text-[var(--color-mint)] underline underline-offset-2
            hover:opacity-80 transition-opacity
            focus-visible:outline-2 focus-visible:outline-[var(--color-mint)] rounded
          "
          aria-label={`Upgrade KYC from tier ${tier} to increase daily limit`}
        >
          Upgrade to {tier === 0 ? 'Tier 1' : 'Full ID'} →
        </button>
      )}
    </div>
  )
}
