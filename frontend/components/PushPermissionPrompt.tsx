'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Bell, X } from 'lucide-react'
import { useRouter } from 'next/navigation'

export function PushPermissionPrompt() {
  const router = useRouter()
  const [show, setShow] = useState(false)

  useEffect(() => {
    // Only show if supported and not already granted/denied
    if (!('Notification' in window)) return
    if (Notification.permission !== 'default') return
    
    // In a real app, track if we already asked them in localStorage
    const asked = localStorage.getItem('remitchain:push_asked')
    if (asked) return

    // Show after a delay
    const timer = setTimeout(() => setShow(true), 2000)
    return () => clearTimeout(timer)
  }, [])

  const handleClose = () => {
    localStorage.setItem('remitchain:push_asked', '1')
    setShow(false)
  }

  const handleEnable = () => {
    handleClose()
    router.push('/settings/notifications')
  }

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="fixed bottom-24 left-4 right-4 z-40 p-4 rounded-2xl shadow-xl flex items-start gap-4"
          style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-mint-dim)' }}
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
        >
          <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
            style={{ background: 'var(--color-mint-dim)' }}>
            <Bell className="w-5 h-5" style={{ color: 'var(--color-mint)' }} />
          </div>
          
          <div className="flex-1">
            <h3 className="font-bold text-sm mb-1" style={{ color: 'var(--color-text-primary)' }}>Turn on notifications?</h3>
            <p className="text-xs mb-3" style={{ color: 'var(--color-text-secondary)' }}>
              Know instantly when your money is claimed.
            </p>
            <div className="flex items-center gap-2">
              <button onClick={handleEnable}
                className="px-4 py-2 rounded-lg text-xs font-semibold press-scale"
                style={{ background: 'var(--color-mint)', color: 'var(--color-ink)' }}>
                Enable
              </button>
              <button onClick={handleClose}
                className="px-4 py-2 rounded-lg text-xs font-semibold press-scale"
                style={{ background: 'var(--color-surface)', color: 'var(--color-text-secondary)' }}>
                Not now
              </button>
            </div>
          </div>
          
          <button onClick={handleClose} className="p-1 -mt-1 -mr-1 rounded-full" style={{ color: 'var(--color-text-tertiary)' }}>
            <X className="w-4 h-4" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
