'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, Check, Loader2 } from 'lucide-react'
import { useAccount } from 'wagmi'
import { getContact } from '@/lib/contacts/db'
import type { Contact } from '@/lib/contacts/types'

export default function NewSchedulePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { address } = useAccount()
  
  const contactId = searchParams.get('contactId')
  const amountStr = searchParams.get('amount')
  
  const [contact, setContact] = useState<Contact | null>(null)
  const [amount, setAmount] = useState(amountStr || '')
  const [frequency, setFrequency] = useState<'weekly' | 'monthly'>('monthly')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (contactId) {
      getContact(contactId).then(c => {
        if (c) setContact(c)
      })
    }
  }, [contactId])

  const handleSave = async () => {
    if (!address) { setError('Connect wallet first'); return }
    if (!contact) { setError('Select a contact from Contacts page first'); return }
    const numAmount = parseFloat(amount)
    if (isNaN(numAmount) || numAmount <= 0) { setError('Invalid amount'); return }

    setSaving(true)
    setError('')
    
    // Calculate next run: 1 week or 1 month from today
    const now = new Date()
    if (frequency === 'weekly') now.setDate(now.getDate() + 7)
    else now.setMonth(now.getMonth() + 1)
    
    const payload = {
      ownerAddress: address,
      contactId: contact.id,
      contactName: contact.name,
      amount: numAmount,
      corridorId: 'PHP', // Fixed for demo
      frequency,
      nextRunAt: now.getTime(),
    }

    try {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      
      if (!res.ok) throw new Error('Failed to create')
      router.push('/schedules')
    } catch {
      setError('Failed to create schedule')
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ink)' }}>
      <div className="flex items-center gap-3 px-4 pt-14 pb-4" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <button onClick={() => router.back()} className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: 'var(--color-surface)' }}>
          <ArrowLeft className="w-5 h-5" style={{ color: 'var(--color-text-primary)' }} />
        </button>
        <h1 className="text-lg font-bold flex-1" style={{ color: 'var(--color-text-primary)', letterSpacing: '-0.03em' }}>New Schedule</h1>
      </div>

      <main className="flex-1 px-4 pt-6 space-y-6">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--color-text-tertiary)' }}>Recipient</label>
          <div className="w-full h-14 px-4 rounded-xl text-base flex items-center"
            style={{ background: 'var(--color-surface)', color: contact ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }}>
            {contact ? contact.name : 'Select from Contacts page first'}
          </div>
        </div>
        
        <div>
          <label className="block text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--color-text-tertiary)' }}>Amount (QUSD)</label>
          <input 
            type="number"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0.00"
            className="w-full h-14 px-4 rounded-xl text-base outline-none font-mono"
            style={{ background: 'var(--color-surface)', color: 'var(--color-text-primary)' }}
          />
        </div>
        
        <div>
          <label className="block text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--color-text-tertiary)' }}>Frequency</label>
          <div className="flex gap-2">
            {(['weekly', 'monthly'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFrequency(f)}
                className="flex-1 h-12 rounded-xl text-sm font-semibold capitalize"
                style={{ 
                  background: frequency === f ? 'var(--color-mint-dim)' : 'var(--color-surface)',
                  color: frequency === f ? 'var(--color-mint)' : 'var(--color-text-primary)',
                  border: frequency === f ? '1px solid var(--color-mint)' : '1px solid transparent'
                }}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        
        {error && <p className="text-sm text-center" style={{ color: 'var(--color-coral)' }}>{error}</p>}
        
        <button
          onClick={handleSave}
          disabled={saving || !contact || !amount}
          className="w-full h-14 rounded-xl font-semibold flex items-center justify-center gap-2 press-scale mt-8"
          style={{ background: 'var(--color-mint)', color: 'var(--color-ink)', opacity: (!contact || !amount || saving) ? 0.5 : 1 }}
        >
          {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check className="w-5 h-5" />}
          Schedule Transfer
        </button>
      </main>
    </div>
  )
}
