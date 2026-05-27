'use client'

import Link from 'next/link'
import { useAccount } from 'wagmi'
import { AddressChip } from '@/components/ui/AddressChip'

interface NavBarProps {
  hideConnect?: boolean
}

export function NavBar({ hideConnect }: NavBarProps = {}) {
  const { address, isConnected } = useAccount()

  return (
    <header
      role="banner"
      className="fixed top-0 left-0 right-0 z-[var(--z-nav)] flex items-center justify-between px-4 sm:px-6 h-16"
      style={{
        background: 'rgba(10,10,11,0.85)',
        backdropFilter: 'blur(16px)',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      {/* Logo */}
      <Link
        href="/"
        className="flex items-center gap-2 font-bold text-base"
        style={{ color: 'var(--color-text-primary)' }}
        aria-label="RemitChain — go to home"
      >
        <div
          aria-hidden
          className="w-7 h-7 rounded-lg flex items-center justify-center font-black text-sm"
          style={{ background: 'var(--color-mint)', color: 'var(--color-ink)' }}
        >
          R
        </div>
        <span className="hidden sm:inline">RemitChain</span>
      </Link>

      {/* Right side */}
      <nav
        className="flex items-center gap-2 sm:gap-3"
        aria-label="Primary navigation"
      >

        {isConnected && address ? (
          <AddressChip address={address} />
        ) : !hideConnect ? (
          <>
            <Link
              href="/claim"
              id="nav-claim"
              className="
                hidden sm:inline-flex items-center h-9 px-4 rounded-lg text-sm font-medium
                transition-colors hover:text-[var(--color-text-primary)]
              "
              style={{ color: 'var(--color-text-secondary)' }}
              aria-label="Claim a transfer"
            >
              Claim
            </Link>
            <Link
              href="/connect"
              id="nav-connect"
              className="press-scale inline-flex items-center h-9 px-4 rounded-lg text-sm font-semibold transition-colors"
              style={{
                background: 'var(--color-mint)',
                color: 'var(--color-ink)',
              }}
              aria-label="Connect wallet"
            >
              Connect
            </Link>
          </>
        ) : null}
      </nav>
    </header>
  )
}
