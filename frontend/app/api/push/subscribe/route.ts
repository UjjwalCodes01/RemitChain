import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { env } from '@/lib/env'

// In-memory store for hackathon demo. Replace with Vercel KV in production.
// Key: walletAddress (lowercase), Value: PushSubscription JSON
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

  // Store subscription — use Vercel KV if configured
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) {
    // TODO: Use @vercel/kv when KV env vars are connected
    // await kv.set(`push:${address.toLowerCase()}`, subscription)
  }
  inMemoryStore.set(address.toLowerCase(), subscription)

  return NextResponse.json({ ok: true })
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')?.toLowerCase()
  if (!address) return NextResponse.json({ subscription: null })

  const subscription = inMemoryStore.get(address) ?? null
  return NextResponse.json({ subscription })
}
