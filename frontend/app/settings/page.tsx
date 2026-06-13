'use client'

import { useState, useEffect } from 'react'
import { motion } from 'motion/react'
import { ArrowLeft, Fingerprint, Bell, Globe, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MobileNavBar } from '@/components/MobileNavBar'
import { isBiometricRegistered, browserSupportsWebAuthn } from '@/lib/biometric/webauthn'
import { activeChain } from '@/lib/chains'

export default function SettingsPage() {
  const router = useRouter()
  const [biometricOn, setBiometricOn] = useState(false)

  useEffect(() => {
    isBiometricRegistered().then(setBiometricOn)
  }, [])

  const ITEMS = [
    {
      icon: Fingerprint,
      label: 'Biometric Lock',
      desc: biometricOn ? 'Enabled — Face ID / Fingerprint' : 'Protect app with biometrics',
      href: '/settings/biometric',
      color: 'var(--color-mint)',
      badge: biometricOn ? 'On' : undefined,
    },
    {
      icon: Bell,
      label: 'Notifications',
      desc: 'Get notified when transfers are claimed',
      href: '/settings/notifications',
      color: '#F5A623',
      badge: undefined,
    },
    {
      icon: Globe,
      label: 'Language',
      desc: 'English, हिन्दी, Español, العربية…',
      href: '/settings/language',
      color: '#5B9CF6',
      badge: undefined,
    },
  ]

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ink)', paddingBottom: 'calc(64px + env(safe-area-inset-bottom, 0px))' }}>
      <div className="px-4 pt-14 pb-4 sticky top-0 z-10"
        style={{ background: 'rgba(10,10,11,0.92)', backdropFilter: 'blur(20px)', borderBottom: '1px solid var(--color-border)' }}>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--color-text-primary)', letterSpacing: '-0.03em' }}>Settings</h1>
      </div>

      <main className="flex-1 px-4 pt-6">
        <div className="space-y-2">
          {ITEMS.map(({ icon: Icon, label, desc, href, color, badge }) => (
            <motion.div key={href} whileTap={{ scale: 0.98 }}>
              <Link href={href}
                className="flex items-center gap-4 p-4 rounded-2xl"
                style={{ background: 'var(--color-surface)', textDecoration: 'none' }}>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: `${color}22` }}>
                  <Icon className="w-5 h-5" style={{ color }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm" style={{ color: 'var(--color-text-primary)' }}>{label}</p>
                  <p className="text-xs truncate" style={{ color: 'var(--color-text-secondary)' }}>{desc}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {badge && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                      style={{ background: 'var(--color-mint-dim)', color: 'var(--color-mint)' }}>
                      {badge}
                    </span>
                  )}
                  <ChevronRight className="w-4 h-4" style={{ color: 'var(--color-text-tertiary)' }} />
                </div>
              </Link>
            </motion.div>
          ))}
        </div>

        <div className="mt-8 text-center">
          <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>RemitChain v0.2.0 · {activeChain.name}</p>
        </div>
      </main>

      <MobileNavBar />
    </div>
  )
}
