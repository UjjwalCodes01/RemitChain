'use client'

import { motion, useSpring, useMotionValueEvent } from 'motion/react'
import { useState, useEffect } from 'react'

const DEMO_AMOUNTS = [100, 250, 500, 1000, 2500]
const FX_RATE = 83.45 // USD → INR (seeded)

function formatNum(v: number): string {
  return v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function LiquidNumberPreview() {
  const [idx, setIdx] = useState(0)
  const [isHovered, setIsHovered] = useState(false)
  const [displayAmount, setDisplayAmount] = useState(formatNum(DEMO_AMOUNTS[0]))
  const [displayConverted, setDisplayConverted] = useState(
    formatNum(DEMO_AMOUNTS[0] * FX_RATE)
  )

  // Auto-cycle unless hovered
  useEffect(() => {
    if (isHovered) return
    const t = setInterval(() => {
      setIdx(i => (i + 1) % DEMO_AMOUNTS.length)
    }, 2000)
    return () => clearInterval(t)
  }, [isHovered])

  const amount = DEMO_AMOUNTS[idx]
  const springConfig = { stiffness: 120, damping: 20, mass: 0.8 }
  const springAmount = useSpring(amount, springConfig)
  const springConverted = useSpring(amount * FX_RATE, springConfig)

  // Drive spring targets when amount changes
  useEffect(() => {
    springAmount.set(amount)
    springConverted.set(amount * FX_RATE)
  }, [amount, springAmount, springConverted])

  // Subscribe to spring output → update display strings
  useMotionValueEvent(springAmount, 'change', v => setDisplayAmount(formatNum(v)))
  useMotionValueEvent(springConverted, 'change', v => setDisplayConverted(formatNum(v)))

  return (
    <div
      className="relative w-full max-w-sm mx-auto"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      role="presentation"
      aria-hidden="true"
    >
      {/* Phone frame */}
      <div
        className="relative rounded-[2rem] p-1 mx-auto"
        style={{
          width: 280,
          background: 'linear-gradient(135deg, var(--color-surface-elevated), var(--color-surface))',
          border: '1px solid var(--color-border-strong)',
          boxShadow: 'var(--shadow-lg), var(--shadow-mint)',
        }}
      >
        <div
          className="rounded-[1.6rem] overflow-hidden"
          style={{ background: 'var(--color-surface)', padding: '32px 24px 28px' }}
        >
          {/* Label */}
          <p
            className="text-xs uppercase tracking-widest mb-4 text-center font-semibold"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            You send
          </p>

          {/* The Liquid Number */}
          <div className="flex items-start justify-center gap-1 mb-2">
            <span
              className="text-2xl font-bold pt-3"
              style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}
            >
              $
            </span>
            <motion.span
              key={displayAmount}
              className="text-[5rem] font-bold leading-none tabular-nums"
              style={{
                fontFamily: 'var(--font-mono)',
                letterSpacing: '-0.04em',
                color: 'var(--color-text-primary)',
                display: 'block',
              }}
              initial={{ opacity: 0.6, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
            >
              {displayAmount}
            </motion.span>
          </div>

          {/* Recipient gets */}
          <div
            className="rounded-xl p-3 mt-4"
            style={{
              background: 'var(--color-mint-dim)',
              border: '1px solid var(--color-mint-glow)',
            }}
          >
            <p className="text-xs mb-1" style={{ color: 'var(--color-mint)' }}>
              Recipient gets
            </p>
            <div className="flex items-baseline gap-1">
              <span
                className="text-xl font-bold tabular-nums"
                style={{ color: 'var(--color-mint)', fontFamily: 'var(--font-mono)' }}
              >
                ₹
              </span>
              <motion.span
                key={displayConverted}
                className="text-2xl font-bold tabular-nums"
                style={{ color: 'var(--color-mint)', fontFamily: 'var(--font-mono)' }}
                initial={{ opacity: 0.6, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.15 }}
              >
                {displayConverted}
              </motion.span>
            </div>
            <p
              className="text-xs mt-1"
              style={{ color: 'var(--color-mint)', opacity: 0.6 }}
            >
              via UPI · ₹83.45/$ · 0.1% fee
            </p>
          </div>

          {/* Selector dots */}
          <div className="flex items-center justify-center gap-2 mt-6">
            {DEMO_AMOUNTS.map((a, i) => (
              <button
                key={a}
                onClick={() => setIdx(i)}
                className="transition-all"
                style={{
                  width: i === idx ? 20 : 6,
                  height: 6,
                  borderRadius: 3,
                  background:
                    i === idx ? 'var(--color-mint)' : 'var(--color-border-strong)',
                  border: 'none',
                  cursor: 'pointer',
                }}
                aria-label={`Set demo amount to $${a}`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Caption */}
      <p
        className="text-center text-xs mt-6"
        style={{ color: 'var(--color-text-tertiary)' }}
      >
        Click dots to change amount · Try the real thing on the send screen
      </p>
    </div>
  )
}
