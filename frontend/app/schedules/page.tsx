'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Plus, CalendarClock, Play, Pause, Trash2, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MobileNavBar } from '@/components/MobileNavBar'
import { BottomSheet } from '@/components/BottomSheet'
import { useAccount } from 'wagmi'
import type { RecurringSchedule } from '@/lib/schedules/types'
import { format } from 'date-fns'

export default function SchedulesPage() {
  const router = useRouter()
  const { address } = useAccount()
  const [schedules, setSchedules] = useState<RecurringSchedule[]>([])
  const [loading, setLoading] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const fetchSchedules = async () => {
    if (!address) { setLoading(false); return }
    const res = await fetch(`/api/schedules?address=${address}`)
    if (res.ok) {
      const data = await res.json()
      setSchedules(data.schedules)
    }
    setLoading(false)
  }

  useEffect(() => { fetchSchedules() }, [address])

  const handleAction = (schedule: RecurringSchedule) => {
    setSelectedId(schedule.id)
    setSheetOpen(true)
  }

  const toggleActive = async () => {
    if (!selectedId) return
    const s = schedules.find(x => x.id === selectedId)
    if (!s) return
    
    setSheetOpen(false)
    setSchedules(prev => prev.map(x => x.id === selectedId ? { ...x, active: !x.active } : x))
    await fetch('/api/schedules', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: selectedId, active: !s.active })
    })
  }

  const handleDelete = async () => {
    if (!selectedId) return
    setSheetOpen(false)
    setSchedules(prev => prev.filter(x => x.id !== selectedId))
    await fetch(`/api/schedules?id=${selectedId}`, { method: 'DELETE' })
  }

  const selected = schedules.find(x => x.id === selectedId)

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ink)', paddingBottom: 'calc(64px + env(safe-area-inset-bottom, 0px))' }}>
      <div className="sticky top-0 z-20 px-4 pt-12 pb-4"
        style={{ background: 'rgba(10,10,11,0.92)', backdropFilter: 'blur(20px)', borderBottom: '1px solid var(--color-border)' }}>
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--color-text-primary)', letterSpacing: '-0.03em' }}>
            Recurring
          </h1>
          <Link
            href="/schedules/new"
            className="w-10 h-10 rounded-xl flex items-center justify-center press-scale"
            style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-mint)' }}
            aria-label="New schedule"
          >
            <Plus className="w-5 h-5" />
          </Link>
        </div>
      </div>

      <main className="flex-1 px-4 pt-4">
        {loading ? (
          <div className="flex justify-center p-8"><div className="w-6 h-6 border-2 border-[var(--color-mint)] border-t-transparent rounded-full animate-spin" /></div>
        ) : schedules.length === 0 ? (
          <motion.div
            className="flex flex-col items-center justify-center py-20 text-center"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6"
              style={{ background: 'var(--color-surface-elevated)' }}>
              <CalendarClock className="w-10 h-10" style={{ color: 'var(--color-text-tertiary)' }} />
            </div>
            <h2 className="text-lg font-semibold mb-2" style={{ color: 'var(--color-text-primary)' }}>No schedules yet</h2>
            <p className="text-sm mb-6" style={{ color: 'var(--color-text-secondary)' }}>
              Schedule automated transfers to family so you never forget.
            </p>
            <Link
              href="/contacts"
              className="inline-flex items-center gap-2 h-12 px-6 rounded-xl font-semibold text-sm press-scale"
              style={{ background: 'var(--color-mint)', color: 'var(--color-ink)' }}
            >
              <Plus className="w-4 h-4" /> Schedule a transfer
            </Link>
            <p className="text-xs mt-4" style={{ color: 'var(--color-text-tertiary)' }}>Select a contact first</p>
          </motion.div>
        ) : (
          <div className="space-y-3 pb-4">
            {schedules.map(s => (
              <motion.button
                key={s.id}
                onClick={() => handleAction(s)}
                className="w-full p-4 rounded-2xl text-left press-scale flex flex-col gap-3"
                style={{ 
                  background: 'var(--color-surface)',
                  border: `1px solid ${s.active ? 'var(--color-border)' : 'var(--color-surface-elevated)'}`,
                  opacity: s.active ? 1 : 0.6 
                }}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-semibold text-sm" style={{ color: 'var(--color-text-primary)' }}>{s.contactName}</p>
                    <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                      {s.frequency.charAt(0).toUpperCase() + s.frequency.slice(1)} • {s.amount} QUSD
                    </p>
                  </div>
                  <div className="px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wide"
                    style={{ background: s.active ? 'var(--color-mint-dim)' : 'var(--color-surface-elevated)', color: s.active ? 'var(--color-mint)' : 'var(--color-text-tertiary)' }}>
                    {s.active ? 'Active' : 'Paused'}
                  </div>
                </div>
                
                <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                  <CalendarClock className="w-3.5 h-3.5" />
                  Next: {format(new Date(s.nextRunAt), 'MMM do, yyyy')}
                </div>
              </motion.button>
            ))}
          </div>
        )}
      </main>

      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Manage Schedule">
        <div className="p-4 space-y-2">
          <button
            onClick={toggleActive}
            className="w-full flex items-center gap-3 p-4 rounded-xl text-left"
            style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text-primary)' }}
          >
            {selected?.active ? (
              <><Pause className="w-5 h-5" style={{ color: 'var(--color-text-secondary)' }} /> Pause schedule</>
            ) : (
              <><Play className="w-5 h-5" style={{ color: 'var(--color-mint)' }} /> Resume schedule</>
            )}
          </button>
          <button
            onClick={handleDelete}
            className="w-full flex items-center gap-3 p-4 rounded-xl text-left"
            style={{ background: 'rgba(255,107,92,0.08)', color: 'var(--color-coral)' }}
          >
            <Trash2 className="w-5 h-5" /> Delete schedule
          </button>
        </div>
      </BottomSheet>

      <MobileNavBar />
    </div>
  )
}
