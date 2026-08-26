import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./lib/i18n/request.ts')

const nextConfig: NextConfig = {
  // Type errors used to be ignored at build time. On a codebase that moves
  // money, a type error is exactly the class of bug you want the build to
  // catch — a mismatched unit or a missing null check reaches production
  // otherwise. The build now fails on them.
  typescript: {
    ignoreBuildErrors: false,
  },

  // Never ship a source map that reveals server-side logic to the browser.
  productionBrowserSourceMaps: false,

  // `x-powered-by: Next.js` is free reconnaissance.
  poweredByHeader: false,

  // Ensure cookies work properly with wagmi SSR
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' }
        ]
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // DENY prevents any iframe embedding — critical for financial apps
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
          },
          // Force HTTPS for two years including subdomains.
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Next.js inline scripts + wagmi/viem
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              // Inline styles from emotion/framer/tailwind
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              // The browser only ever talks to our own API and the QIE RPC.
              // Razorpay, Resend, Neon, Upstash and the FX API are reached
              // exclusively from server routes, so allowing the browser to
              // connect to them only widened the exfiltration surface.
              "connect-src 'self' https://*.qie.digital wss://*.qie.digital",
              "img-src 'self' data: blob:",
              "frame-src 'none'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ]
  },
}

export default withNextIntl(nextConfig)
