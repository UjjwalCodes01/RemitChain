'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Globe, Check } from 'lucide-react'
import { locales, localeNames, type Locale } from '@/lib/i18n/config'
import { motion } from 'motion/react'

function getCurrentLocale(): Locale {
  if (typeof document === 'undefined') return 'en'
  const match = document.cookie.match(/NEXT_LOCALE=([a-z]+)/)
  return (match?.[1] as Locale) ?? 'en'
}

function setLocale(locale: Locale) {
  document.cookie = `NEXT_LOCALE=${locale}; path=/; max-age=31536000; SameSite=Lax`
}

export default function LanguageSettingsPage() {
  const router = useRouter()
  const [selected, setSelected] = useState<Locale>(getCurrentLocale())

  const handleSelect = (locale: Locale) => {
    setSelected(locale)
    setLocale(locale)
    // Reload to apply new locale (next-intl reads cookie at request time)
    setTimeout(() => router.refresh(), 100)
  }

  const rtl = ['ar', 'ur'].includes(selected)

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ink)' }}>
      <div className="flex items-center gap-3 px-4 pt-14 pb-4" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <button onClick={() => router.back()} className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: 'var(--color-surface)' }}>
          <ArrowLeft className="w-5 h-5" style={{ color: 'var(--color-text-primary)' }} />
        </button>
        <h1 className="text-lg font-bold flex-1" style={{ color: 'var(--color-text-primary)', letterSpacing: '-0.03em' }}>Language</h1>
      </div>

      <main className="flex-1 px-4 pt-6">
        <div className="space-y-2">
          {locales.map(locale => (
            <motion.button
              key={locale}
              whileTap={{ scale: 0.98 }}
              onClick={() => handleSelect(locale)}
              className="w-full flex items-center gap-4 p-4 rounded-2xl text-left"
              style={{ background: selected === locale ? 'var(--color-mint-dim)' : 'var(--color-surface)', border: `1px solid ${selected === locale ? 'var(--color-mint-glow)' : 'transparent'}` }}
              dir={['ar', 'ur'].includes(locale) ? 'rtl' : 'ltr'}
            >
              <div className="flex-1">
                <p className="font-semibold text-sm" style={{ color: 'var(--color-text-primary)' }}>{localeNames[locale]}</p>
                {locale !== 'en' && <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                  {locale === 'hi' && 'Hindi'}
                  {locale === 'tl' && 'Tagalog — Filipino'}
                  {locale === 'es' && 'Spanish'}
                  {locale === 'bn' && 'Bengali'}
                  {locale === 'ur' && 'Urdu'}
                  {locale === 'ar' && 'Arabic'}
                </p>}
              </div>
              {selected === locale && <Check className="w-5 h-5 shrink-0" style={{ color: 'var(--color-mint)' }} />}
            </motion.button>
          ))}
        </div>
        <p className="text-xs text-center mt-6" style={{ color: 'var(--color-text-tertiary)' }}>
          Full translations: English + Hindi. Others coming soon.
        </p>
      </main>
    </div>
  )
}
