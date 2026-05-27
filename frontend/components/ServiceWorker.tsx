'use client'

import { useEffect } from 'react'

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
      navigator.serviceWorker.register('/sw.js').catch(err => {
        console.error('Service worker registration failed:', err)
      })
    }
  }, [])
  return null
}
