'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { NavBar } from '@/components/NavBar'
import { motion } from 'motion/react'
import { ArrowRight } from 'lucide-react'

export default function ClaimIndexPage() {
  const [txId, setTxId] = useState('')
  const router = useRouter()

  const handleContinue = () => {
    let input = txId.trim()
    if (input.length > 5) {
      // If the user pasted a full URL (e.g. from the 'Copy claim link' button)
      // Extract everything after /claim/ to avoid nested routes (404)
      if (input.includes('/claim/')) {
        input = input.substring(input.indexOf('/claim/') + 7)
      } else if (input.startsWith('claim/')) {
        input = input.substring(6)
      }
      
      router.push(`/claim/${input}`)
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ink)' }}>
      <NavBar hideConnect />
      
      <main className="flex-1 flex flex-col items-center justify-center px-4 pt-24 pb-16">
        <motion.div 
          className="w-full max-w-sm mx-auto"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="mb-10 text-center">
            <h1 className="text-3xl font-bold mb-3 tracking-tight">Claim Funds</h1>
            <p style={{ color: 'var(--color-text-secondary)' }}>
              Enter the Transfer ID provided by the sender.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            <input
              type="text"
              value={txId}
              onChange={e => setTxId(e.target.value)}
              placeholder="e.g. 0x123..."
              className="w-full h-14 px-4 rounded-xl text-sm border outline-none transition-colors"
              style={{
                background: 'var(--color-surface)',
                borderColor: txId ? 'var(--color-mint)' : 'var(--color-border)',
                color: 'var(--color-text-primary)',
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') handleContinue()
              }}
            />

            <button
              disabled={txId.length < 5}
              onClick={handleContinue}
              className="w-full h-14 rounded-xl font-semibold flex items-center justify-center transition-all"
              style={{
                background: txId.length >= 5 ? 'var(--color-mint)' : 'var(--color-surface-elevated)',
                color: txId.length >= 5 ? 'var(--color-ink)' : 'var(--color-text-tertiary)',
              }}
            >
              Continue
              {txId.length >= 5 && <ArrowRight className="w-5 h-5 ml-2" />}
            </button>
          </div>
        </motion.div>
      </main>
    </div>
  )
}
