'use client'

import dynamic from 'next/dynamic'

const DemoBanner = dynamic(
  () => import('@/components/DemoBanner').then(m => m.DemoBanner),
  { ssr: false }
)

export function DemoBannerClient() {
  return <DemoBanner />
}
