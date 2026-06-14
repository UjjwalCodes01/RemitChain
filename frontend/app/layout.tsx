import type { Metadata, Viewport } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import { headers, cookies } from 'next/headers'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'
import { Web3Provider } from '@/providers/Web3Provider'
import { cookieToInitialState } from 'wagmi'
import { wagmiConfig } from '@/lib/wagmi'
import { BiometricGateClient } from '@/components/BiometricGateClient'
import { PushPermissionPrompt } from '@/components/PushPermissionPrompt'
import { ServiceWorkerRegistration } from '@/components/ServiceWorker'
import { DemoBannerClient } from '@/components/DemoBannerClient'
import { defaultLocale } from '@/lib/i18n/config'
import { Analytics } from '@vercel/analytics/react'
import './globals.css'

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
})

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'RemitChain — Send money home. Not 5% of it.',
  description:
    'Phone-number-only cross-border remittance on QIE blockchain. 0.1% fee, QUSD escrow, OTP claim. No wallet, no seed phrase for recipients.',
  keywords: ['remittance', 'cross-border', 'QIE', 'blockchain', 'QUSD', 'migrant workers'],
  authors: [{ name: 'RemitChain' }],
  metadataBase: new URL('https://remit-chain.vercel.app'),
  openGraph: {
    title: 'RemitChain — Send money home. Not 5% of it.',
    description: '0.1% fee cross-border remittance on QIE blockchain.',
    type: 'website',
  },
  manifest: '/manifest.json',
  icons: {
    apple: '/icons/apple-touch-icon.png',
  },
}

export const viewport: Viewport = {
  themeColor: '#0A0A0B',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const cookieStore = await cookies()
  const locale = cookieStore.get('NEXT_LOCALE')?.value || defaultLocale
  const messages = await getMessages()
  const headersList = await headers()
  const cookieString = headersList.get('cookie')
  const decodedCookie = cookieString ? decodeURIComponent(cookieString) : null
  
  const initialState = cookieToInitialState(
    wagmiConfig,
    decodedCookie
  )

  return (
    <html
      lang={locale}
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
      dir={['ar', 'ur'].includes(locale) ? 'rtl' : 'ltr'}
    >
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body>
        <NextIntlClientProvider messages={messages} locale={locale}>
          <Web3Provider initialState={initialState}>
            <BiometricGateClient>
              <div id="app-root" className="min-h-screen flex flex-col">
                <DemoBannerClient />
                {children}
              </div>
              <PushPermissionPrompt />
              <ServiceWorkerRegistration />
              {/* Polite live region for tx state announcements (screen readers) */}
              <div
                id="tx-announcer"
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="sr-only"
              />
            </BiometricGateClient>
          </Web3Provider>
        </NextIntlClientProvider>
        <Analytics />
      </body>
    </html>
  )
}
