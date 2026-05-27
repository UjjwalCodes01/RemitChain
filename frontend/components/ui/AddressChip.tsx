'use client'

import { useDisconnect } from 'wagmi'
import { motion } from 'motion/react'

interface AddressChipProps {
  address: `0x${string}`
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function AddressChip({ address }: AddressChipProps) {
  const { disconnect } = useDisconnect()

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex items-center gap-2"
    >
      <div
        className="
          flex items-center gap-2 h-9 px-3
          bg-[var(--color-surface-elevated)] border border-[var(--color-border-strong)]
          rounded-full text-sm font-mono text-[var(--color-text-secondary)]
        "
      >
        <span className="glow-dot" aria-hidden />
        <span aria-label={`Connected address ${address}`}>
          {truncateAddress(address)}
        </span>
      </div>
      <button
        onClick={() => disconnect()}
        className="
          h-9 px-3 rounded-full text-xs text-[var(--color-text-tertiary)]
          hover:text-[var(--color-coral)] hover:bg-[var(--color-coral-dim)]
          border border-[var(--color-border)] transition-colors
          focus-visible:outline-2 focus-visible:outline-[var(--color-mint)]
        "
        aria-label="Disconnect wallet"
      >
        Disconnect
      </button>
    </motion.div>
  )
}
