'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, Users, Send, CalendarClock, Settings } from 'lucide-react'

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Home', icon: Home },
  { href: '/contacts', label: 'Contacts', icon: Users },
  { href: '/send', label: 'Send', icon: Send, primary: true },
  { href: '/schedules', label: 'Recurring', icon: CalendarClock },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export function MobileNavBar() {
  const pathname = usePathname()

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around"
      style={{
        background: 'rgba(10,10,11,0.92)',
        backdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--color-border)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        height: 'calc(64px + env(safe-area-inset-bottom, 0px))',
      }}
      aria-label="Main navigation"
    >
      {NAV_ITEMS.map(({ href, label, icon: Icon, primary }) => {
        const active = pathname === href || pathname.startsWith(href + '/')
        return primary ? (
          <Link
            key={href}
            href={href}
            aria-label={label}
            className="flex items-center justify-center w-14 h-14 rounded-2xl -mt-4 press-scale transition-transform"
            style={{
              background: 'var(--color-mint)',
              boxShadow: '0 0 24px rgba(61,220,151,0.4)',
            }}
          >
            <Icon className="w-6 h-6" style={{ color: 'var(--color-ink)' }} aria-hidden />
          </Link>
        ) : (
          <Link
            key={href}
            href={href}
            aria-label={label}
            className="flex flex-col items-center justify-center gap-1 min-w-11 min-h-11 px-2 py-2"
          >
            <Icon
              className="w-5 h-5 transition-colors"
              style={{ color: active ? 'var(--color-mint)' : 'var(--color-text-tertiary)' }}
              aria-hidden
            />
            <span
              className="text-[10px] font-medium transition-colors"
              style={{ color: active ? 'var(--color-mint)' : 'var(--color-text-tertiary)' }}
            >
              {label}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
