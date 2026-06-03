'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { FlaskConical, X } from 'lucide-react'
import Link from 'next/link'

/**
 * DemoBanner — shown when NEXT_PUBLIC_DEMO_MODE=true.
 * Slim amber banner that sets judge expectations: OTPs appear on-screen,
 * not via SMS. Dismissible for the session (no persistence needed).
 */
export function DemoBanner() {
  const [dismissed, setDismissed] = useState(false)

  if (process.env.NEXT_PUBLIC_DEMO_MODE !== 'true') return null

  return (
    <AnimatePresence>
      {!dismissed && (
        <motion.div
          initial={{ opacity: 0, y: -40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -40 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="fixed top-0 left-0 right-0 z-[200] flex items-center justify-between gap-3 px-4 py-2"
          style={{
            background: 'rgba(245,166,35,0.12)',
            borderBottom: '1px solid rgba(245,166,35,0.35)',
            backdropFilter: 'blur(8px)',
          }}
          role="alert"
          aria-label="Demo Mode active"
        >
          <div className="flex items-center gap-2 min-w-0">
            <FlaskConical className="w-4 h-4 shrink-0" style={{ color: '#F5A623' }} aria-hidden />
            <p className="text-xs font-medium truncate" style={{ color: '#F5A623' }}>
              <span className="font-bold">Demo Mode</span>
              {' — '}
              OTPs shown on-screen for judge testing.
              {' '}
              <span className="hidden sm:inline" style={{ opacity: 0.75 }}>
                In production, codes are sent via SMS. Real transfer, real escrow.
              </span>
            </p>
            <Link
              href="/demo"
              className="hidden sm:inline-flex shrink-0 text-xs font-semibold px-2.5 py-1 rounded-md transition-colors"
              style={{ background: 'rgba(245,166,35,0.2)', color: '#F5A623', border: '1px solid rgba(245,166,35,0.4)' }}
            >
              Open control panel →
            </Link>
          </div>
          <button
            onClick={() => setDismissed(true)}
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md transition-colors hover:bg-white/10"
            style={{ color: '#F5A623' }}
            aria-label="Dismiss demo banner"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
