export interface Contact {
  id: string          // crypto.randomUUID()
  name: string
  phoneE164: string   // e.g. "+919876543210"
  phoneHash: string   // keccak256 of normalized phone — used for matching, not stored on-chain
  avatarDataUrl?: string  // base64 WebP, 256x256
  pinnedAt?: number   // timestamp ms — if set, shown in pinned section
  lastSentAt?: number // timestamp ms of most recent transfer
  createdAt: number
}

export type NewContact = Omit<Contact, 'id' | 'createdAt'>
