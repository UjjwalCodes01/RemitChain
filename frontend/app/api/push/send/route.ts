import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { sendPushNotification } from '@/lib/push/vapid'

// Import the in-memory store (for hackathon demo)
// In production: query Vercel KV
const subscriptionSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  title: z.string().min(1).max(100),
  body: z.string().min(1).max(200),
  url: z.string().optional(),
})

export async function POST(req: NextRequest) {
  // Internal-only endpoint — should be called only from server-side routes
  const authHeader = req.headers.get('x-internal-secret')
  if (authHeader !== process.env.INTERNAL_SECRET && process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const parsed = subscriptionSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const { address, title, body: notifBody, url } = parsed.data

  // Fetch subscription for this address
  const subscribeRes = await fetch(
    `${req.nextUrl.origin}/api/push/subscribe?address=${address}`,
    { cache: 'no-store' }
  )
  const { subscription } = await subscribeRes.json()
  if (!subscription) return NextResponse.json({ ok: true, sent: false })

  try {
    await sendPushNotification(subscription, { title, body: notifBody, url })
    return NextResponse.json({ ok: true, sent: true })
  } catch (err) {
    console.error('Push send failed:', err)
    return NextResponse.json({ ok: false, error: 'Push failed' }, { status: 500 })
  }
}
