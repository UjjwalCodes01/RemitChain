import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { RecurringSchedule, NewSchedule } from '@/lib/schedules/types'

// In-memory store for hackathon demo. Replace with Vercel KV in production.
const scheduleStore = new Map<string, RecurringSchedule>()

const createSchema = z.object({
  ownerAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  contactId: z.string(),
  contactName: z.string(),
  amount: z.number().positive(),
  corridorId: z.string(),
  frequency: z.enum(['weekly', 'monthly', 'custom']),
  dayOfMonth: z.number().min(1).max(28).optional(),
  nextRunAt: z.number().positive(),
})

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')?.toLowerCase()
  if (!address) return NextResponse.json({ schedules: [] })

  const schedules = Array.from(scheduleStore.values())
    .filter(s => s.ownerAddress.toLowerCase() === address)
    .sort((a, b) => a.nextRunAt - b.nextRunAt)

  return NextResponse.json({ schedules })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body', details: parsed.error.issues }, { status: 400 })

  const schedule: RecurringSchedule = {
    ...parsed.data,
    id: crypto.randomUUID(),
    active: true,
    createdAt: Date.now(),
  }
  scheduleStore.set(schedule.id, schedule)

  return NextResponse.json({ schedule }, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const body = await req.json()
  const id = body.id as string
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const existing = scheduleStore.get(id)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const updated = { ...existing, ...body, id }
  scheduleStore.set(id, updated)
  return NextResponse.json({ schedule: updated })
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
  scheduleStore.delete(id)
  return NextResponse.json({ ok: true })
}
