'use client'

import dynamic from 'next/dynamic'

// idb-keyval uses IndexedDB which doesn't exist in Node.js.
// We MUST use ssr:false here, inside a 'use client' component,
// so the entire biometric module tree is excluded from the SSR bundle.
const BiometricGate = dynamic(
  () => import('./BiometricGate').then(m => m.BiometricGate),
  {
    ssr: false,
    loading: () => null, // render nothing while loading — children flash in on hydration
  }
)

export function BiometricGateClient({ children }: { children: React.ReactNode }) {
  return <BiometricGate>{children}</BiometricGate>
}
