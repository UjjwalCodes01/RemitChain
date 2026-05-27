'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Bell, BellOff, Loader2 } from 'lucide-react'
import { useAccount } from 'wagmi'
import { env } from '@/lib/env'

export default function NotificationsSettingsPage() {
  const router = useRouter()
  const { address } = useAccount()
  const [subscribed, setSubscribed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [supported, setSupported] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      setSupported(true)
      navigator.serviceWorker.ready.then(reg => {
        reg.pushManager.getSubscription().then(sub => {
          setSubscribed(!!sub)
          setLoading(false)
        })
      })
    } else {
      setLoading(false)
    }
  }, [])

  const handleSubscribe = async () => {
    if (!address) { setStatus('Connect wallet first'); return }
    if (!env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) { setStatus('VAPID keys not configured'); return }
    
    setLoading(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setStatus('Permission denied')
        setLoading(false)
        return
      }

      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      })

      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, subscription: sub.toJSON() })
      })

      if (res.ok) {
        setSubscribed(true)
        setStatus('Notifications enabled!')
        if (navigator.vibrate) navigator.vibrate([30, 50, 30])
      } else {
        setStatus('Failed to save subscription')
      }
    } catch (err) {
      setStatus('Error enabling push: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleUnsubscribe = async () => {
    setLoading(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) await sub.unsubscribe()
      setSubscribed(false)
      setStatus('Notifications disabled')
    } catch {
      setStatus('Failed to disable')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ink)' }}>
      <div className="flex items-center gap-3 px-4 pt-14 pb-4" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <button onClick={() => router.back()} className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: 'var(--color-surface)' }}>
          <ArrowLeft className="w-5 h-5" style={{ color: 'var(--color-text-primary)' }} />
        </button>
        <h1 className="text-lg font-bold flex-1" style={{ color: 'var(--color-text-primary)', letterSpacing: '-0.03em' }}>Notifications</h1>
      </div>

      <main className="flex-1 flex flex-col items-center px-6 pt-12">
        <div className="w-24 h-24 rounded-3xl flex items-center justify-center mb-8"
          style={{ background: subscribed ? 'rgba(61,220,151,0.1)' : 'var(--color-surface)', border: `2px solid ${subscribed ? 'var(--color-mint)' : 'var(--color-border-strong)'}` }}>
          {subscribed
            ? <Bell className="w-12 h-12" style={{ color: 'var(--color-mint)' }} />
            : <BellOff className="w-12 h-12" style={{ color: 'var(--color-text-tertiary)' }} />}
        </div>

        <h2 className="text-xl font-bold mb-2 text-center" style={{ color: 'var(--color-text-primary)' }}>
          {subscribed ? 'Notifications On' : 'Stay Updated'}
        </h2>
        <p className="text-sm text-center mb-8" style={{ color: 'var(--color-text-secondary)', maxWidth: '280px' }}>
          {subscribed
            ? 'You will receive an alert when a recipient claims their funds.'
            : 'Enable push notifications to know instantly when your transfers are claimed.'}
        </p>

        {!supported ? (
          <p className="text-sm text-center" style={{ color: 'var(--color-coral)' }}>
            Push notifications not supported in this browser. If on iOS, add this app to your Home Screen first.
          </p>
        ) : (
          <button
            onClick={subscribed ? handleUnsubscribe : handleSubscribe}
            disabled={loading}
            className="w-full max-w-xs h-14 rounded-2xl font-semibold flex items-center justify-center gap-3 press-scale"
            style={{
              background: subscribed ? 'var(--color-surface-elevated)' : 'var(--color-mint)',
              color: subscribed ? 'var(--color-coral)' : 'var(--color-ink)',
              border: subscribed ? '1px solid var(--color-coral)' : 'none',
            }}
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Bell className="w-5 h-5" />}
            {subscribed ? 'Disable' : 'Enable Notifications'}
          </button>
        )}

        {status && (
          <p className="mt-4 text-sm text-center" style={{ color: status.includes('!') ? 'var(--color-mint)' : 'var(--color-text-tertiary)' }}>
            {status}
          </p>
        )}
      </main>
    </div>
  )
}
