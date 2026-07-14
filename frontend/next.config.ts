import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./lib/i18n/request.ts')

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  // Allow reading absolute paths from node_modules
  experimental: {},

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
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
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
              // QIE RPC, Resend, Razorpay, open.er-api.com FX, Neon DB
              "connect-src 'self' https://*.qie.digital wss://*.qie.digital https://api.resend.com https://api.razorpay.com https://open.er-api.com https://*.neon.tech https://*.upstash.io",
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
