'use client'

import { motion, AnimatePresence } from 'motion/react'
import { Fingerprint, Loader2 } from 'lucide-react'
import { useBiometricLock } from '@/lib/biometric/lock'

interface BiometricGateProps {
  children: React.ReactNode
}

export function BiometricGate({ children }: BiometricGateProps) {
  const { lockState, unlocking, unlock } = useBiometricLock()

  // Pass through while checking or if not registered
  if (lockState === 'unknown' || lockState === 'not_registered' || lockState === 'unlocked') {
    return <>{children}</>
  }

  return (
    <>
      {children}
      <AnimatePresence>
        {lockState === 'locked' && (
          <motion.div
            className="fixed inset-0 z-50 flex flex-col items-center justify-center px-8"
            style={{ background: 'rgba(10,10,11,0.97)', backdropFilter: 'blur(20px)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="flex flex-col items-center gap-6 text-center"
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              transition={{ delay: 0.1, type: 'spring', stiffness: 200 }}
            >
              <div className="w-24 h-24 rounded-3xl flex items-center justify-center"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border-strong)' }}>
                <div className="w-14 h-14 rounded-full flex items-center justify-center"
                  style={{ background: 'var(--color-mint-dim)' }}>
                  <Fingerprint className="w-8 h-8" style={{ color: 'var(--color-mint)' }} />
                </div>
              </div>

              <div>
                <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--color-text-primary)' }}>RemitChain Locked</h2>
                <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                  Use Face ID or fingerprint to unlock
                </p>
              </div>

              <button
                onClick={unlock}
                disabled={unlocking}
                className="h-14 px-8 rounded-2xl font-semibold flex items-center gap-3 press-scale"
                style={{ background: 'var(--color-mint)', color: 'var(--color-ink)' }}
                aria-label="Unlock with biometrics"
              >
                {unlocking ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Fingerprint className="w-5 h-5" />
                )}
                {unlocking ? 'Verifying…' : 'Unlock'}
              </button>

              <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                Your wallet signature is still required for transactions.
                <br />Biometrics only gate access to the app.
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
