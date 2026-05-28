/**
 * app/api/push/subscribe/route.ts
 *
 * Web Push subscription storage — migrated from in-memory Map to DB.
 * Degrades to in-memory when DB is absent (local dev).
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db, pushSubscriptions } from '@/lib/db'

// In-memory fallback
const inMemoryStore = new Map<string, object>()

const subscribeSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string(),
      auth: z.string(),
    }),
  }),
})

export async function POST(req: NextRequest) {
  const body = await req.json()
  const parsed = subscribeSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const { address, subscription } = parsed.data

  if (db) {
    await db
      .insert(pushSubscriptions)
      .values({
        userAddress: address.toLowerCase(),
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userAddress: address.toLowerCase(),
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
        },
      })
  } else {
    inMemoryStore.set(address.toLowerCase(), subscription)
  }

  return NextResponse.json({ ok: true })
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')?.toLowerCase()
  if (!address) return NextResponse.json({ subscription: null })

  if (db) {
    const rows = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userAddress, address))
      .limit(1)

    if (!rows[0]) return NextResponse.json({ subscription: null })

    return NextResponse.json({
      subscription: {
        endpoint: rows[0].endpoint,
        keys: { p256dh: rows[0].p256dh, auth: rows[0].auth },
      },
    })
  }

  const sub = inMemoryStore.get(address)
  return NextResponse.json({ subscription: sub ?? null })
}
