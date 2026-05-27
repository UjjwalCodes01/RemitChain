import webpush from 'web-push'
import { env } from '@/lib/env'

if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
  webpush.setVapidDetails(
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  )
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
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.warn('VAPID keys not configured — push skipped')
    return
  }
  await webpush.sendNotification(subscription, JSON.stringify(payload))
}
