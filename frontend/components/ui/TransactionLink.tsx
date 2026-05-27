import { ExternalLink } from 'lucide-react'

interface TransactionLinkProps {
  txHash: `0x${string}`
  label?: string
  short?: boolean
}

const EXPLORER_BASE = 'https://testnet.qie.digital'

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`
}

export function TransactionLink({
  txHash,
  label,
  short = true,
}: TransactionLinkProps) {
  const displayText = label ?? (short ? shortHash(txHash) : txHash)

  return (
    <a
      href={`${EXPLORER_BASE}/tx/${txHash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="
        inline-flex items-center gap-1 text-sm font-mono
        text-[var(--color-mint)] hover:opacity-80 transition-opacity
        focus-visible:outline-2 focus-visible:outline-[var(--color-mint)] rounded
      "
      aria-label={`View transaction ${txHash} on QIE Explorer (opens in new tab)`}
    >
      {displayText}
      <ExternalLink className="w-3 h-3" aria-hidden />
    </a>
  )
}
