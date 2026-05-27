'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { ArrowLeft, Fingerprint, ShieldCheck, Loader2 } from 'lucide-react'
import { isBiometricRegistered, registerBiometric, removeBiometric, browserSupportsWebAuthn } from '@/lib/biometric/webauthn'
import { useAccount } from 'wagmi'

export default function BiometricSettingsPage() {
  const router = useRouter()
  const { address } = useAccount()
  const [registered, setRegistered] = useState(false)
  const [supported, setSupported] = useState(false)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    setSupported(browserSupportsWebAuthn())
    isBiometricRegistered().then(setRegistered)
  }, [])

  const handleEnable = async () => {
    if (!address) { setStatus('Connect your wallet first'); return }
    setLoading(true)
    setStatus('')
    const ok = await registerBiometric(address, `RemitChain User ${address.slice(0, 6)}`)
    setLoading(false)
    if (ok) {
      setRegistered(true)
      setStatus('Biometric lock enabled!')
      if (navigator.vibrate) navigator.vibrate([30, 50, 30])
    } else {
      setStatus('Failed to register biometric. Try again.')
    }
  }

  const handleDisable = async () => {
    setLoading(true)
    await removeBiometric()
    setRegistered(false)
    setLoading(false)
    setStatus('Biometric lock disabled.')
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ink)' }}>
      <div className="flex items-center gap-3 px-4 pt-14 pb-4" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <button onClick={() => router.back()} className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: 'var(--color-surface)' }}>
          <ArrowLeft className="w-5 h-5" style={{ color: 'var(--color-text-primary)' }} />
        </button>
        <h1 className="text-lg font-bold flex-1" style={{ color: 'var(--color-text-primary)', letterSpacing: '-0.03em' }}>Biometric Lock</h1>
      </div>

      <main className="flex-1 flex flex-col items-center px-6 pt-12">
        <div className="w-24 h-24 rounded-3xl flex items-center justify-center mb-8"
          style={{ background: registered ? 'var(--color-mint-dim)' : 'var(--color-surface)', border: `2px solid ${registered ? 'var(--color-mint)' : 'var(--color-border-strong)'}` }}>
          {registered
            ? <ShieldCheck className="w-12 h-12" style={{ color: 'var(--color-mint)' }} />
            : <Fingerprint className="w-12 h-12" style={{ color: 'var(--color-text-tertiary)' }} />}
        </div>

        <h2 className="text-xl font-bold mb-2 text-center" style={{ color: 'var(--color-text-primary)' }}>
          {registered ? 'Biometric Lock Active' : 'Protect Your Account'}
        </h2>
        <p className="text-sm text-center mb-8" style={{ color: 'var(--color-text-secondary)', maxWidth: '280px' }}>
          {registered
            ? 'Your app is protected with Face ID or fingerprint. Locks after 5 minutes in background.'
            : 'Enable Face ID or fingerprint to lock the app. Your wallet signature is still required for transactions.'}
        </p>

        {!supported ? (
          <p className="text-sm text-center" style={{ color: 'var(--color-coral)' }}>
            Biometrics not supported on this device/browser.
          </p>
        ) : (
          <button
            onClick={registered ? handleDisable : handleEnable}
            disabled={loading}
            className="w-full max-w-xs h-14 rounded-2xl font-semibold flex items-center justify-center gap-3 press-scale"
            style={{
              background: registered ? 'var(--color-surface-elevated)' : 'var(--color-mint)',
              color: registered ? 'var(--color-coral)' : 'var(--color-ink)',
              border: registered ? '1px solid var(--color-coral)' : 'none',
            }}
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Fingerprint className="w-5 h-5" />}
            {registered ? 'Disable' : 'Enable Biometric Lock'}
          </button>
        )}

        {status && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="mt-4 text-sm text-center"
            style={{ color: status.includes('!') ? 'var(--color-mint)' : 'var(--color-coral)' }}>
            {status}
          </motion.p>
        )}
      </main>
    </div>
  )
}
