import { useState, useEffect, useCallback, useRef } from 'react'
import { isBiometricRegistered, verifyBiometric } from './webauthn'

const LOCK_KEY = 'remitchain:biometric:locked'
const AUTO_LOCK_MS = 5 * 60 * 1000 // 5 minutes

export type LockState = 'unknown' | 'unlocked' | 'locked' | 'not_registered'

export function useBiometricLock() {
  const [lockState, setLockState] = useState<LockState>('unknown')
  const [unlocking, setUnlocking] = useState(false)
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const resetTimer = useCallback(() => {
    if (lockTimer.current) clearTimeout(lockTimer.current)
    lockTimer.current = setTimeout(async () => {
      const registered = await isBiometricRegistered()
      if (registered) {
        const { set } = await import('idb-keyval')
        await set(LOCK_KEY, true)
        setLockState('locked')
      }
    }, AUTO_LOCK_MS)
  }, [])

  const checkLock = useCallback(async () => {
    const registered = await isBiometricRegistered()
    if (!registered) { setLockState('not_registered'); return }

    const { get } = await import('idb-keyval')
    const locked = await get<boolean>(LOCK_KEY)
    setLockState(locked === true ? 'locked' : 'unlocked')
    if (locked !== true) resetTimer()
  }, [resetTimer])

  useEffect(() => {
    checkLock()

    // Lock when backgrounded
    const handleVisibility = () => {
      if (document.hidden) {
        lockTimer.current && clearTimeout(lockTimer.current)
      } else {
        checkLock()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      if (lockTimer.current) clearTimeout(lockTimer.current)
    }
  }, [checkLock])

  const unlock = useCallback(async (): Promise<boolean> => {
    setUnlocking(true)
    try {
      const ok = await verifyBiometric()
      if (ok) {
        const { set } = await import('idb-keyval')
        await set(LOCK_KEY, false)
        setLockState('unlocked')
        resetTimer()
        if (navigator.vibrate) navigator.vibrate(30)
      }
      return ok
    } finally {
      setUnlocking(false)
    }
  }, [resetTimer])

  return { lockState, unlocking, unlock, recheckLock: checkLock }
}
