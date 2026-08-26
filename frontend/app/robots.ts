import type { MetadataRoute } from 'next'
import { appUrl, IS_PRODUCTION_CHAIN } from '@/lib/env'

/**
 * Generated rather than served from public/robots.txt, which hard-coded
 * `https://remitchain.vercel.app` — a domain the app is not actually deployed
 * on. Both the sitemap URL and the rules now follow NEXT_PUBLIC_APP_URL, so a
 * custom domain needs no code change.
 */
export default function robots(): MetadataRoute.Robots {
  // Keep non-production deployments out of search results entirely, so a
  // testnet build cannot outrank or be mistaken for the real service.
  if (!IS_PRODUCTION_CHAIN) {
    return { rules: { userAgent: '*', disallow: '/' } }
  }

  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/api/',
        // Claim and transfer URLs identify a specific transfer. They must
        // never be indexed.
        '/claim/',
        '/transfer/',
        '/faucet',
        '/dashboard',
        '/contacts',
        '/settings',
      ],
    },
    sitemap: `${appUrl()}/sitemap.xml`,
  }
}
