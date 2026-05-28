import webpush from 'web-push'
import { env } from '@/lib/env'

const vapidPublicKey = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
const vapidPrivateKey = env.VAPID_PRIVATE_KEY
const vapidSubject = env.VAPID_SUBJECT

if (vapidPublicKey && vapidPrivateKey && vapidSubject) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey)
}

export interface PushPayload {
  title: string
  body: string
  url?: string
}

export async function sendPushNotification(
  subscription: webpush.PushSubscription,
  payload: PushPayload
): Promise<void> {
  if (!vapidPublicKey || !vapidPrivateKey) {
    console.warn('VAPID keys not configured — push skipped')
    return
  }
  await webpush.sendNotification(subscription, JSON.stringify(payload))
}
