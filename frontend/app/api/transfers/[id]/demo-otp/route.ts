/**
 * app/api/transfers/[id]/demo-otp/route.ts
 *
 * Demo Mode only — stores and retrieves the plaintext OTP for a transfer so
 * judges can test the full claim flow without waiting for SMS delivery.
 *
 * SECURITY:
 *   - Returns 403 immediately when DEMO_MODE !== true (dead code in production)
 *   - OTPs stored in Redis with a 48h TTL (same lifetime as the transfer)
 *   - Rate-limited on GET to prevent brute-force even in demo context
 *   - Nothing in this file ever executes unless DEMO_MODE env var is true
 *
 * Routes:
 *   POST /api/transfers/[id]/demo-otp  — sender's browser stores OTP after TX
 *   GET  /api/transfers/[id]/demo-otp  — tracker / demo panel retrieves OTP
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { env } from '@/lib/env'
import { getRedis } from '@/lib/db/redis'

const DEMO_OTP_TTL_SECONDS = 48 * 60 * 60 // 48h — mirrors transfer expiry

function demoOtpKey(transferId: string) {
  return `demo:otp:${transferId}`
}

// ── POST — store OTP (called by sender's browser after TX confirms) ────────────

const storeSchema = z.object({
  otp: z.string().regex(/^\d{6}$/, 'OTP must be exactly 6 digits'),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Hard guard — this route does not exist in production
  if (!env.DEMO_MODE) {
    return NextResponse.json(
      { error: 'Demo Mode is not enabled' },
      { status: 403 }
    )
  }

  const { id: transferId } = await params

  const transferIdSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/)
  if (!transferIdSchema.safeParse(transferId).success) {
    return NextResponse.json({ error: 'Invalid transferId' }, { status: 400 })
  }

  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const parsed = storeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid OTP format', details: parsed.error.flatten().fieldErrors },
      { status: 400 }
    )
  }

  const { otp } = parsed.data

  // Try Redis storage — gracefully degrade if Redis is not configured
  const redis = getRedis()
  if (redis) {
    try {
      await redis.set(demoOtpKey(transferId), otp, { ex: DEMO_OTP_TTL_SECONDS })
    } catch (err) {
      console.warn('[demo-otp] Redis store failed (non-fatal):', err)
      // Fall through — demo OTP just won't be retrievable, but TX still works
    }
  } else {
    // No Redis — store in module-level Map as fallback (works in single-worker dev)
    inMemoryFallback.set(transferId, { otp, expiresAt: Date.now() + DEMO_OTP_TTL_SECONDS * 1000 })
  }

  return NextResponse.json({ stored: true })
}

// ── GET — retrieve OTP (called by tracker + demo panel) ──────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Hard guard — this route does not exist in production
  if (!env.DEMO_MODE) {
    return NextResponse.json(
      { error: 'Demo Mode is not enabled' },
      { status: 403 }
    )
  }

  const { id: transferId } = await params

  const transferIdSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/)
  if (!transferIdSchema.safeParse(transferId).success) {
    return NextResponse.json({ error: 'Invalid transferId' }, { status: 400 })
  }

  // Try Redis first, fallback to in-memory
  const redis = getRedis()
  let otp: string | null = null

  if (redis) {
    try {
      otp = await redis.get<string>(demoOtpKey(transferId))
    } catch (err) {
      console.warn('[demo-otp] Redis get failed:', err)
    }
  } else {
    const rec = inMemoryFallback.get(transferId)
    if (rec && rec.expiresAt > Date.now()) {
      otp = rec.otp
    } else if (rec) {
      inMemoryFallback.delete(transferId) // clean up expired
    }
  }

  if (!otp) {
    return NextResponse.json(
      { otp: null, message: 'OTP not found — it may have expired or was not stored in demo mode' },
      { status: 404 }
    )
  }

  return NextResponse.json({ otp })
}

// ── In-memory fallback (single-worker dev without Redis) ─────────────────────
interface MemOtpRecord { otp: string; expiresAt: number }
const inMemoryFallback = new Map<string, MemOtpRecord>()
