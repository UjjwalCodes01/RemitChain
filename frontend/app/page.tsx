import Link from 'next/link'
import { ArrowRight, Shield, Zap, Globe2, Users, CalendarClock, Contact, BarChart2, Repeat, CheckCircle2 } from 'lucide-react'
import { Metadata } from 'next'
import { LiquidNumberPreview } from '@/components/LiquidNumberPreview'
import { CorridorStrip } from '@/components/CorridorStrip'
import { NavBar } from '@/components/NavBar'
import { activeChain } from '@/lib/chains'

export const metadata: Metadata = {
  title: 'RemitChain — Send money home. Not 5% of it.',
  description:
    'Phone-number-only cross-border remittance. 0.1% flat fee. No wallet needed for recipients. Built on QIE blockchain.',
}

export default function LandingPage() {
  return (
    <div
      className="relative min-h-screen flex flex-col"
      style={{ background: 'var(--color-ink)' }}
    >
      {/* Ambient gradient — behind everything */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 overflow-hidden"
      >
        <div
          style={{
            position: 'absolute',
            top: '-20%',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '80vw',
            height: '60vh',
            background: 'radial-gradient(ellipse at center, rgba(61,220,151,0.06) 0%, transparent 70%)',
            filter: 'blur(40px)',
          }}
        />
      </div>

      <NavBar />

      {/* ── Hero ── */}
      <section
        id="hero"
        className="relative flex flex-1 flex-col items-center justify-center text-center px-4 pt-16 pb-24 min-h-screen"
        aria-labelledby="hero-heading"
      >
        {/* Eyebrow */}
        <div
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full border mb-8"
          style={{
            borderColor: 'var(--color-border-strong)',
            background: 'var(--color-surface)',
            color: 'var(--color-mint)',
            fontSize: '12px',
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          Live on {activeChain.name} · Chain {activeChain.id}
        </div>

        {/* Main headline */}
        <h1
          id="hero-heading"
          className="text-[clamp(2.8rem,8vw,6rem)] font-bold leading-none tracking-tight mb-6 max-w-4xl"
          style={{ letterSpacing: '-0.04em', color: 'var(--color-text-primary)' }}
        >
          Send money home.
          <br />
          <span style={{ color: 'var(--color-mint)' }}>Not 5% of it.</span>
        </h1>

        {/* Subhead */}
        <p
          className="text-lg max-w-xl mb-10"
          style={{ color: 'var(--color-text-secondary)', lineHeight: 1.7 }}
        >
          Built for the 281 million people who support families across borders.
          QUSD escrow · OTP claim · 0.1% flat fee · No wallet for recipients.
        </p>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row items-center gap-3 mb-16">
          <Link
            href="/send"
            id="cta-send"
            className="press-scale inline-flex items-center justify-center gap-2 h-14 px-8 rounded-xl font-semibold text-base transition-all"
            style={{
              background: 'var(--color-mint)',
              color: 'var(--color-ink)',
              boxShadow: '0 0 40px rgba(61,220,151,0.35)',
              minWidth: '200px',
            }}
            aria-label="Send money — go to send screen"
          >
            Send money
            <ArrowRight className="w-5 h-5" aria-hidden />
          </Link>
          <Link
            href="/claim"
            id="cta-claim"
            className="press-scale inline-flex items-center justify-center gap-2 h-14 px-8 rounded-xl font-semibold text-base transition-colors"
            style={{
              background: 'var(--color-surface-elevated)',
              color: 'var(--color-text-secondary)',
              border: '1px solid var(--color-border-strong)',
              minWidth: '200px',
            }}
            aria-label="Claim a transfer — enter your OTP"
          >
            Claim a transfer
          </Link>
        </div>

        {/* Trust indicators */}
        <div
          className="flex items-center gap-6 text-sm flex-wrap justify-center"
          style={{ color: 'var(--color-text-tertiary)' }}
        >
          {[
            { icon: Shield, label: 'On-chain escrow. Funds can\'t disappear.' },
            { icon: Zap, label: '0.1% fee — beats every incumbent.' },
            { icon: Globe2, label: 'Gulf · UK · USA corridors.' },
          ].map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-2">
              <Icon className="w-4 h-4 shrink-0" aria-hidden />
              <span>{label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Features Grid ── */}
      <section
        id="features"
        aria-label="Platform features"
        className="py-16 px-4 border-t"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4" style={{ letterSpacing: '-0.03em', color: 'var(--color-text-primary)' }}>
              Everything you need to move money
            </h2>
            <p style={{ color: 'var(--color-text-secondary)' }}>
              A full-stack remittance platform disguised as a simple messaging app.
            </p>
          </div>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <FeatureCard 
              icon={Zap} 
              title="Instant Single Send" 
              desc="Send QUSD to any phone number globally. Arrives in under 3 seconds."
            />
            <FeatureCard 
              icon={Users} 
              title="Group Transfers" 
              desc="Pay your entire family back home in one single transaction."
            />
            <FeatureCard 
              icon={CalendarClock} 
              title="Recurring Schedules" 
              desc="Set it and forget it. Automate your monthly remittances on-chain."
            />
            <FeatureCard 
              icon={Contact} 
              title="Smart Address Book" 
              desc="Save frequent contacts. Secured locally on your device."
            />
            <FeatureCard 
              icon={CheckCircle2} 
              title="SMS Claim Links" 
              desc="Recipients get an SMS with a link and OTP. No app download required."
            />
            <FeatureCard 
              icon={BarChart2} 
              title="Live Tracking" 
              desc="Watch your transfer move across the globe in real-time."
            />
          </div>
        </div>
      </section>

      {/* ── Signature Moment: Liquid Number Preview ── */}
      <section
        id="liquid-number"
        aria-label="Interactive amount preview"
        className="py-24 px-4 flex flex-col items-center"
      >
        <div className="max-w-2xl w-full text-center mb-12">
          <h2
            className="text-3xl font-bold mb-4"
            style={{ letterSpacing: '-0.03em', color: 'var(--color-text-primary)' }}
          >
            Sending feels different here.
          </h2>
          <p style={{ color: 'var(--color-text-secondary)' }}>
            Not a form. Not a wire transfer page. An amount that moves when you touch it.
          </p>
        </div>
        <LiquidNumberPreview />
      </section>

      {/* ── Corridor trust strip ── */}
      <section
        id="corridors"
        aria-label="Supported remittance corridors and fee comparison"
        className="py-16 border-t"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="max-w-6xl mx-auto px-4">
          <p
            className="text-center text-sm mb-8 font-semibold uppercase tracking-widest"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            Supported corridors
          </p>
          <CorridorStrip />
        </div>
      </section>

      {/* ── Footer ── */}
      <footer
        role="contentinfo"
        className="py-8 px-4 border-t text-center"
        style={{
          borderColor: 'var(--color-border)',
          color: 'var(--color-text-tertiary)',
          fontSize: '12px',
        }}
      >
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4 flex-wrap justify-center">
            <span>Chain ID <span className="font-mono" style={{ color: 'var(--color-text-secondary)' }}>{activeChain.id}</span></span>
            <span>·</span>
            <a
              href="https://mainnet.qie.digital/address/0x56c650167e2D3a20A1131bC3b9e23449bC604AEa"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono hover:text-[var(--color-mint)] transition-colors"
              aria-label="RemitChain contract on QIE Explorer"
            >
              RemitChain
            </a>
            <span>·</span>
            <a
              href="https://mainnet.qie.digital/address/0xaab80c35136e336f3d0fcf113bd1a092bf206832"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono hover:text-[var(--color-mint)] transition-colors"
              aria-label="KYCRegistry contract on QIE Explorer"
            >
              KYCRegistry
            </a>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--color-text-secondary)] transition-colors"
              aria-label="RemitChain GitHub (opens in new tab)"
            >
              GitHub
            </a>
            <span>·</span>
            <span>© 2026 RemitChain</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

function FeatureCard({ icon: Icon, title, desc }: { icon: any, title: string, desc: string }) {
  return (
    <div className="p-6 rounded-2xl border transition-colors hover:bg-white/5"
      style={{
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
      }}>
      <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
        style={{ 
          background: 'var(--color-surface-elevated)', 
          border: '1px solid var(--color-border)'
        }}>
        <Icon className="w-6 h-6" style={{ color: 'var(--color-mint)' }} />
      </div>
      <h3 className="font-semibold text-lg mb-2" style={{ color: 'var(--color-text-primary)' }}>
        {title}
      </h3>
      <p className="text-sm" style={{ color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
        {desc}
      </p>
    </div>
  )
}
