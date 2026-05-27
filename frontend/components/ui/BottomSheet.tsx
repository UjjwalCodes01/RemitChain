'use client'

import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { X } from 'lucide-react'

interface BottomSheetProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
}

export function BottomSheet({ isOpen, onClose, title, children }: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null)

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    if (isOpen) {
      document.addEventListener('keydown', handleKey)
      document.body.style.overflow = 'hidden'
    }
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.body.style.overflow = ''
    }
  }, [isOpen, onClose])

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[var(--z-modal)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            aria-hidden
          />

          {/* Sheet */}
          <motion.div
            key="sheet"
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label={title ?? 'Bottom sheet'}
            className="
              fixed bottom-0 left-0 right-0 z-[calc(var(--z-modal)+1)]
              bg-[var(--color-surface)] border-t border-[var(--color-border-strong)]
              rounded-t-2xl shadow-[0_-8px_40px_rgba(0,0,0,0.6)]
              pb-[env(safe-area-inset-bottom)]
              max-h-[90dvh] overflow-y-auto
            "
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 350, damping: 35 }}
            drag="y"
            dragConstraints={{ top: 0 }}
            dragElastic={0.15}
            onDragEnd={(_, info) => {
              if (info.offset.y > 100) onClose()
            }}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-2 cursor-grab active:cursor-grabbing" aria-hidden>
              <div className="w-10 h-1 rounded-full bg-[var(--color-border-strong)]" />
            </div>

            {/* Header */}
            {title && (
              <div className="flex items-center justify-between px-5 pb-4">
                <h2 className="text-base font-semibold text-[var(--color-text-primary)]">
                  {title}
                </h2>
                <button
                  onClick={onClose}
                  className="
                    w-8 h-8 flex items-center justify-center rounded-full
                    text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]
                    hover:bg-[var(--color-surface-elevated)] transition-colors
                    focus-visible:outline-2 focus-visible:outline-[var(--color-mint)]
                  "
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            <div className="px-5 pb-6">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
