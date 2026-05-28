/**
 * app/stats/page.tsx
 *
 * Public judge dashboard — no wallet/auth required.
 * Auto-refreshes every 30s. Shareable URL.
 * Mobile-first. Screenshot-ready.
 */

import type { Metadata } from 'next'
import { StatsClient } from './StatsClient'

export const metadata: Metadata = {
  title: 'RemitChain — Live Stats',
  description:
    'Real-time remittance statistics for RemitChain. Total transfers, volume, fee savings vs Western Union, and corridor breakdown.',
  openGraph: {
    title: 'RemitChain Live Stats',
    description: 'Phone-number-only cross-border remittance. 0.1% flat fee. Built on QIE blockchain.',
  },
}

export default function StatsPage() {
  return <StatsClient />
}
