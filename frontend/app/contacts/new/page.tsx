'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { ArrowLeft, Camera, Check, Loader2 } from 'lucide-react'
import { createContact } from '@/lib/contacts/db'
import { resizeImageToWebP, getInitials } from '@/lib/contacts/avatar'
import { keccak256, toBytes } from 'viem'

function normalizePhone(raw: string): string {
  const cleaned = raw.replace(/[^\d+]/g, '')
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`
}

export default function NewContactPage() {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const dataUrl = await resizeImageToWebP(file)
      setAvatarDataUrl(dataUrl)
    } catch {
      setError('Failed to process image')
    }
  }

  const handleSave = async () => {
    if (!name.trim()) { setError('Name is required'); return }
    if (!phone.trim()) { setError('Phone number is required'); return }
    setSaving(true)
    setError('')
    try {
      const phoneE164 = normalizePhone(phone)
      const phoneHash = keccak256(toBytes(phoneE164))
      await createContact({ name: name.trim(), phoneE164, phoneHash, avatarDataUrl: avatarDataUrl ?? undefined })
      if (navigator.vibrate) navigator.vibrate(30)
      router.push('/contacts')
    } catch {
      setError('Failed to save contact')
      setSaving(false)
    }
  }

  const initials = name ? getInitials(name) : '?'
  const canSave = name.trim().length > 0 && phone.trim().length > 4

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ink)' }}>
      <div className="flex items-center gap-3 px-4 pt-14 pb-4" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <button onClick={() => router.back()} className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: 'var(--color-surface)' }} aria-label="Go back">
          <ArrowLeft className="w-5 h-5" style={{ color: 'var(--color-text-primary)' }} />
        </button>
        <h1 className="text-lg font-bold flex-1" style={{ color: 'var(--color-text-primary)', letterSpacing: '-0.03em' }}>New Contact</h1>
        <button onClick={handleSave} disabled={!canSave || saving}
          className="h-10 px-4 rounded-xl text-sm font-semibold flex items-center gap-2"
          style={{ background: canSave ? 'var(--color-mint)' : 'var(--color-surface)', color: canSave ? 'var(--color-ink)' : 'var(--color-text-tertiary)' }}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          Save
        </button>
      </div>
      <main className="flex-1 px-4 pt-8">
        <div className="flex flex-col items-center mb-8">
          <button onClick={() => fileRef.current?.click()}
            className="relative w-24 h-24 rounded-full overflow-hidden flex items-center justify-center"
            style={{ background: 'var(--color-surface-elevated)', border: '2px dashed var(--color-border-strong)' }}
            aria-label="Add photo">
            {avatarDataUrl
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={avatarDataUrl} alt="avatar" className="w-full h-full object-cover" />
              : <span className="text-3xl font-bold" style={{ color: 'var(--color-mint)' }}>{initials}</span>}
            <div className="absolute bottom-1 right-1 w-7 h-7 rounded-full flex items-center justify-center"
              style={{ background: 'var(--color-mint)', color: 'var(--color-ink)' }}>
              <Camera className="w-3.5 h-3.5" />
            </div>
          </button>
          <p className="text-xs mt-2" style={{ color: 'var(--color-text-tertiary)' }}>Tap to add photo</p>
          <input ref={fileRef} type="file" accept="image/*" capture="user" className="hidden" onChange={handlePhotoSelect} />
        </div>
        <div className="space-y-4">
          <div>
            <label htmlFor="contact-name" className="block text-xs font-semibold uppercase tracking-widest mb-2"
              style={{ color: 'var(--color-text-tertiary)' }}>Full Name</label>
            <input id="contact-name" type="text" placeholder="e.g. Mum" value={name} onChange={e => setName(e.target.value)}
              className="w-full h-14 px-4 rounded-xl text-base outline-none"
              style={{ background: 'var(--color-surface)', border: `1px solid ${name ? 'var(--color-mint)' : 'var(--color-border)'}`, color: 'var(--color-text-primary)' }}
              autoFocus />
          </div>
          <div>
            <label htmlFor="contact-phone" className="block text-xs font-semibold uppercase tracking-widest mb-2"
              style={{ color: 'var(--color-text-tertiary)' }}>Phone Number</label>
            <input id="contact-phone" type="tel" autoComplete="tel" placeholder="+91 98765 43210" value={phone} onChange={e => setPhone(e.target.value)}
              className="w-full h-14 px-4 rounded-xl text-base outline-none"
              style={{ background: 'var(--color-surface)', border: `1px solid ${phone ? 'var(--color-mint)' : 'var(--color-border)'}`, color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)' }} />
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-tertiary)' }}>Include country code, e.g. +91 for India</p>
          </div>
          {error && (
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="text-sm px-4 py-3 rounded-xl"
              style={{ background: 'rgba(255,107,92,0.1)', color: 'var(--color-coral)' }}>
              {error}
            </motion.p>
          )}
        </div>
      </main>
    </div>
  )
}
