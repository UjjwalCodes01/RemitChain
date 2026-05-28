/**
 * app/api/schedules/route.ts
 *
 * Recurring transfer schedules — migrated from in-memory Map to Postgres.
 * Degrades to in-memory when DB is absent.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq, and, desc } from 'drizzle-orm'
import { db, schedules } from '@/lib/db'

// In-memory fallback
const fallbackStore = new Map<string, object>()

const createSchema = z.object({
  senderAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  recipientPhoneHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  recipientNickname: z.string().max(50).optional(),
  amount: z.string(),
  corridor: z.string().min(1),
  frequency: z.enum(['WEEKLY', 'MONTHLY', 'CUSTOM']),
  dayOfMonth: z.number().min(1).max(28).optional(),
  nextRunAt: z.number().positive(),
})

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')?.toLowerCase()
  if (!address) return NextResponse.json({ schedules: [] })

  if (!db) {
    const all = Array.from(fallbackStore.values()) as Array<{ senderAddress?: string }>
    return NextResponse.json({
      schedules: all.filter(s => s.senderAddress?.toLowerCase() === address),
    })
  }

  const rows = await db
    .select()
    .from(schedules)
    .where(and(
      eq(schedules.senderAddress, address),
      eq(schedules.status, 'ACTIVE'),
    ))
    .orderBy(desc(schedules.nextRunAt))

  return NextResponse.json({ schedules: rows })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', details: parsed.error.issues }, { status: 400 })
  }

  const data = parsed.data

  if (!db) {
    const id = crypto.randomUUID()
    const schedule = { ...data, id, status: 'ACTIVE', createdAt: Date.now() }
    fallbackStore.set(id, schedule)
    return NextResponse.json({ schedule }, { status: 201 })
  }

  const [schedule] = await db
    .insert(schedules)
    .values({
      senderAddress: data.senderAddress.toLowerCase(),
      recipientPhoneHash: data.recipientPhoneHash ?? undefined,
      recipientNickname: data.recipientNickname ?? undefined,
      amount: data.amount,
      corridor: data.corridor,
      frequency: data.frequency,
      dayOfMonth: data.dayOfMonth ?? undefined,
      nextRunAt: data.nextRunAt,
      status: 'ACTIVE',
      createdAt: Date.now(),
    })
    .returning()

  return NextResponse.json({ schedule }, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const body = await req.json() as { id?: string; status?: string; nextRunAt?: number }
  const id = body.id as string
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  if (!db) {
    const existing = fallbackStore.get(id) as Record<string, unknown> | undefined
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const updated = { ...existing, ...body }
    fallbackStore.set(id, updated)
    return NextResponse.json({ schedule: updated })
  }

  const [updated] = await db
    .update(schedules)
    .set({
      ...(body.status ? { status: body.status } : {}),
      ...(body.nextRunAt ? { nextRunAt: body.nextRunAt } : {}),
    })
    .where(eq(schedules.id, id))
    .returning()

  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ schedule: updated })
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  if (!db) {
    fallbackStore.delete(id)
    return NextResponse.json({ ok: true })
  }

  await db
    .update(schedules)
    .set({ status: 'CANCELLED' })
    .where(eq(schedules.id, id))

  return NextResponse.json({ ok: true })
}
