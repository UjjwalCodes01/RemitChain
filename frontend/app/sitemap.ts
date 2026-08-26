import type { MetadataRoute } from 'next'
import { appUrl } from '@/lib/env'

/**
 * Only pages that are genuinely public and stable belong here.
 *
 * The previous public/sitemap.xml listed /dashboard and /contacts — both
 * wallet-gated and useless to a crawler — and pinned every entry to a
 * hard-coded domain and a fixed 2026-07-14 date.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = appUrl()
  const lastModified = new Date()

  return [
    { url: base, lastModified, changeFrequency: 'weekly', priority: 1.0 },
    { url: `${base}/send`, lastModified, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${base}/connect`, lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${base}/stats`, lastModified, changeFrequency: 'daily', priority: 0.7 },
    { url: `${base}/claim`, lastModified, changeFrequency: 'monthly', priority: 0.6 },
  ]
}
