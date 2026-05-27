'use client'

import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Plus, Search, Pin, Trash2, Edit2, ChevronRight, UserCircle2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MobileNavBar } from '@/components/MobileNavBar'
import { BottomSheet } from '@/components/BottomSheet'
import type { Contact } from '@/lib/contacts/types'
import { getContacts, deleteContact, pinContact } from '@/lib/contacts/db'
import { getInitials } from '@/lib/contacts/avatar'

export default function ContactsPage() {
  const router = useRouter()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadContacts = async () => {
    const data = await getContacts()
    setContacts(data)
    setLoading(false)
  }

  useEffect(() => { loadContacts() }, [])

  const filtered = contacts.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.phoneE164.includes(search)
  )
  const pinned = filtered.filter(c => c.pinnedAt)
  const unpinned = filtered.filter(c => !c.pinnedAt)

  const handleLongPress = (contact: Contact) => {
    setSelectedContact(contact)
    setSheetOpen(true)
    if (navigator.vibrate) navigator.vibrate(30)
  }

  const handleTap = (contact: Contact) => {
    router.push(`/send?contactId=${contact.id}&phone=${encodeURIComponent(contact.phoneE164)}`)
  }

  const handlePointerDown = (contact: Contact) => {
    longPressTimer.current = setTimeout(() => handleLongPress(contact), 500)
  }
  const handlePointerUp = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
  }

  const handlePin = async () => {
    if (!selectedContact) return
    await pinContact(selectedContact.id, !selectedContact.pinnedAt)
    setSheetOpen(false)
    loadContacts()
  }

  const handleDelete = async () => {
    if (!selectedContact) return
    await deleteContact(selectedContact.id)
    setSheetOpen(false)
    loadContacts()
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ink)', paddingBottom: 'calc(64px + env(safe-area-inset-bottom, 0px))' }}>
      {/* Header */}
      <div
        className="sticky top-0 z-20 px-4 pt-12 pb-3"
        style={{ background: 'rgba(10,10,11,0.92)', backdropFilter: 'blur(20px)', borderBottom: '1px solid var(--color-border)' }}
      >
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--color-text-primary)', letterSpacing: '-0.03em' }}>
            Contacts
          </h1>
          <Link
            href="/contacts/new"
            id="add-contact"
            className="w-10 h-10 rounded-xl flex items-center justify-center press-scale"
            style={{ background: 'var(--color-mint)', color: 'var(--color-ink)' }}
            aria-label="Add new contact"
          >
            <Plus className="w-5 h-5" />
          </Link>
        </div>
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--color-text-tertiary)' }} />
          <input
            type="search"
            placeholder="Search contacts..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full h-10 pl-9 pr-4 rounded-xl text-sm outline-none"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
          />
        </div>
      </div>

      <main className="flex-1 px-4 pt-4">
        {loading ? (
          <div className="space-y-3">
            {[0,1,2,3].map(i => (
              <div key={i} className="flex items-center gap-3 p-3">
                <div className="w-12 h-12 rounded-full skeleton shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-4 w-32 rounded" />
                  <div className="skeleton h-3 w-24 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : contacts.length === 0 ? (
          <motion.div
            className="flex flex-col items-center justify-center py-20 text-center"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6"
              style={{ background: 'var(--color-surface-elevated)' }}>
              <UserCircle2 className="w-10 h-10" style={{ color: 'var(--color-text-tertiary)' }} />
            </div>
            <h2 className="text-lg font-semibold mb-2" style={{ color: 'var(--color-text-primary)' }}>No contacts yet</h2>
            <p className="text-sm mb-6" style={{ color: 'var(--color-text-secondary)' }}>
              Add your family or friends to send money in one tap.
            </p>
            <Link
              href="/contacts/new"
              className="inline-flex items-center gap-2 h-12 px-6 rounded-xl font-semibold text-sm press-scale"
              style={{ background: 'var(--color-mint)', color: 'var(--color-ink)' }}
            >
              <Plus className="w-4 h-4" /> Add first contact
            </Link>
          </motion.div>
        ) : (
          <div className="space-y-1 pb-4">
            {pinned.length > 0 && (
              <>
                <p className="text-xs font-semibold uppercase tracking-widest px-1 mb-2" style={{ color: 'var(--color-text-tertiary)' }}>Pinned</p>
                {pinned.map(c => <ContactRow key={c.id} contact={c} onTap={handleTap} onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} />)}
                {unpinned.length > 0 && <div className="h-px my-3" style={{ background: 'var(--color-border)' }} />}
              </>
            )}
            {unpinned.length > 0 && (
              <>
                {pinned.length > 0 && <p className="text-xs font-semibold uppercase tracking-widest px-1 mb-2" style={{ color: 'var(--color-text-tertiary)' }}>All contacts</p>}
                {unpinned.map(c => <ContactRow key={c.id} contact={c} onTap={handleTap} onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} />)}
              </>
            )}
          </div>
        )}
      </main>

      {/* Long-press bottom sheet */}
      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title={selectedContact?.name}>
        <div className="p-4 space-y-2">
          <button
            onClick={() => { setSheetOpen(false); router.push(`/contacts/${selectedContact?.id}/edit`) }}
            className="w-full flex items-center gap-3 p-4 rounded-xl text-left"
            style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text-primary)' }}
          >
            <Edit2 className="w-5 h-5" style={{ color: 'var(--color-text-secondary)' }} />
            Edit contact
          </button>
          <button
            onClick={handlePin}
            className="w-full flex items-center gap-3 p-4 rounded-xl text-left"
            style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text-primary)' }}
          >
            <Pin className="w-5 h-5" style={{ color: 'var(--color-text-secondary)' }} />
            {selectedContact?.pinnedAt ? 'Unpin' : 'Pin to top'}
          </button>
          <button
            onClick={handleDelete}
            className="w-full flex items-center gap-3 p-4 rounded-xl text-left"
            style={{ background: 'rgba(255,107,92,0.08)', color: 'var(--color-coral)' }}
          >
            <Trash2 className="w-5 h-5" />
            Delete contact
          </button>
        </div>
      </BottomSheet>

      <MobileNavBar />
    </div>
  )
}

function ContactRow({ contact, onTap, onPointerDown, onPointerUp }: {
  contact: Contact
  onTap: (c: Contact) => void
  onPointerDown: (c: Contact) => void
  onPointerUp: () => void
}) {
  const lastSent = contact.lastSentAt
    ? new Date(contact.lastSentAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null

  return (
    <motion.button
      className="w-full flex items-center gap-3 p-3 rounded-2xl text-left active:scale-[0.98] transition-transform"
      style={{ background: 'transparent' }}
      onClick={() => onTap(contact)}
      onPointerDown={() => onPointerDown(contact)}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Avatar */}
      <div className="w-12 h-12 rounded-full overflow-hidden shrink-0 flex items-center justify-center font-bold text-sm"
        style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-mint)' }}>
        {contact.avatarDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={contact.avatarDataUrl} alt={contact.name} className="w-full h-full object-cover" />
        ) : (
          getInitials(contact.name)
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm truncate" style={{ color: 'var(--color-text-primary)' }}>{contact.name}</p>
        <p className="text-xs truncate" style={{ color: 'var(--color-text-tertiary)' }}>{contact.phoneE164}</p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {lastSent && <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{lastSent}</span>}
        {contact.pinnedAt && <Pin className="w-3.5 h-3.5" style={{ color: 'var(--color-mint)' }} />}
        <ChevronRight className="w-4 h-4" style={{ color: 'var(--color-text-tertiary)' }} />
      </div>
    </motion.button>
  )
}
