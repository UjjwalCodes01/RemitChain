'use client'

import { Drawer } from 'vaul'
import { ReactNode } from 'react'

interface BottomSheetProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  snapPoints?: number[]
}

export function BottomSheet({ open, onClose, title, children }: BottomSheetProps) {
  return (
    <Drawer.Root open={open} onOpenChange={v => !v && onClose()} shouldScaleBackground>
      <Drawer.Portal>
        <Drawer.Overlay
          className="fixed inset-0 z-40"
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
        />
        <Drawer.Content
          className="fixed bottom-0 left-0 right-0 z-50 flex flex-col rounded-t-2xl outline-none"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border-strong)',
            borderBottom: 'none',
            maxHeight: '90dvh',
          }}
          aria-label={title ?? 'Sheet'}
        >
          {/* Drag handle */}
          <div className="flex justify-center pt-3 pb-1 shrink-0">
            <div className="w-10 h-1 rounded-full" style={{ background: 'var(--color-border-strong)' }} />
          </div>

          {title && (
            <div
              className="px-5 pb-3 pt-1 shrink-0"
              style={{ borderBottom: '1px solid var(--color-border)' }}
            >
              <Drawer.Title className="font-semibold text-base" style={{ color: 'var(--color-text-primary)' }}>
                {title}
              </Drawer.Title>
            </div>
          )}

          <div className="overflow-y-auto pb-[env(safe-area-inset-bottom,16px)]">
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
