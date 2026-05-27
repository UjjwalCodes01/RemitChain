'use client'

import { motion, AnimatePresence } from 'motion/react'
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react'

export type ButtonState = 'idle' | 'signing' | 'broadcasting' | 'confirmed' | 'error'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  txState?: ButtonState
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  children: React.ReactNode
}

const STATE_LABELS: Record<ButtonState, string> = {
  idle: '',
  signing: 'Waiting for signature…',
  broadcasting: 'Broadcasting…',
  confirmed: 'Confirmed',
  error: 'Failed',
}

export function Button({
  txState = 'idle',
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  children,
  disabled,
  className = '',
  ...props
}: ButtonProps) {
  const isLoading = txState === 'signing' || txState === 'broadcasting'
  const isDisabled = disabled || isLoading

  const base = `
    relative inline-flex items-center justify-center gap-2 font-semibold
    rounded-xl border transition-all press-scale select-none
    focus-visible:outline-2 focus-visible:outline-offset-2
    disabled:pointer-events-none disabled:opacity-50
  `

  const sizes = {
    sm: 'h-9 px-4 text-sm',
    md: 'h-11 px-5 text-sm',
    lg: 'h-14 px-7 text-base',
  }

  const variants = {
    primary: `
      bg-[var(--color-mint)] text-[var(--color-ink)] border-transparent
      hover:bg-[#4AEAA6] focus-visible:outline-[var(--color-mint)]
      shadow-[0_0_24px_rgba(61,220,151,0.3)]
    `,
    secondary: `
      bg-[var(--color-surface-elevated)] text-[var(--color-text-primary)]
      border-[var(--color-border-strong)] hover:bg-[var(--color-surface)]
      focus-visible:outline-[var(--color-mint)]
    `,
    ghost: `
      bg-transparent text-[var(--color-text-secondary)] border-transparent
      hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)]
      focus-visible:outline-[var(--color-mint)]
    `,
    danger: `
      bg-[var(--color-coral-dim)] text-[var(--color-coral)] border-[var(--color-coral)]
      border-opacity-30 hover:bg-[var(--color-coral)] hover:text-white
      focus-visible:outline-[var(--color-coral)]
    `,
  }

  return (
    <motion.button
      whileTap={{ scale: isDisabled ? 1 : 0.97 }}
      transition={{ type: 'spring', stiffness: 400, damping: 20 }}
      className={`
        ${base} ${sizes[size]} ${variants[variant]}
        ${fullWidth ? 'w-full' : ''}
        ${className}
      `}
      disabled={isDisabled}
      aria-disabled={isDisabled}
      aria-busy={isLoading}
      {...(props as React.ComponentProps<typeof motion.button>)}
    >
      <AnimatePresence mode="wait">
        {isLoading ? (
          <motion.span
            key="loading"
            className="flex items-center gap-2"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
            <span>{STATE_LABELS[txState]}</span>
          </motion.span>
        ) : txState === 'confirmed' ? (
          <motion.span
            key="confirmed"
            className="flex items-center gap-2"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ type: 'spring', stiffness: 300 }}
          >
            <CheckCircle2 className="w-4 h-4" aria-hidden />
            {STATE_LABELS.confirmed}
          </motion.span>
        ) : txState === 'error' ? (
          <motion.span
            key="error"
            className="flex items-center gap-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <AlertCircle className="w-4 h-4" aria-hidden />
            {STATE_LABELS.error}
          </motion.span>
        ) : (
          <motion.span
            key="idle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {children}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  )
}
