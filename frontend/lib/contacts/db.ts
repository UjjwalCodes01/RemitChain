import type { Contact, NewContact } from './types'

const PREFIX = 'contact:'

function contactKey(id: string) {
  return `${PREFIX}${id}`
}

export async function getContacts(): Promise<Contact[]> {
  const { keys, getMany } = await import('idb-keyval')
  const allKeys = await keys()
  const contactKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith(PREFIX)) as string[]
  const contacts = await getMany(contactKeys)
  return (contacts.filter(Boolean) as Contact[]).sort((a, b) => {
    // Pinned first, then by lastSentAt desc, then name
    if (a.pinnedAt && !b.pinnedAt) return -1
    if (!a.pinnedAt && b.pinnedAt) return 1
    if (a.pinnedAt && b.pinnedAt) return b.pinnedAt - a.pinnedAt
    if (a.lastSentAt && b.lastSentAt) return b.lastSentAt - a.lastSentAt
    return a.name.localeCompare(b.name)
  })
}

export async function getContact(id: string): Promise<Contact | undefined> {
  const { get } = await import('idb-keyval')
  return get<Contact>(contactKey(id))
}

export async function upsertContact(contact: Contact): Promise<void> {
  const { set } = await import('idb-keyval')
  await set(contactKey(contact.id), contact)
}

export async function createContact(data: NewContact): Promise<Contact> {
  const contact: Contact = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  }
  await upsertContact(contact)
  return contact
}

export async function deleteContact(id: string): Promise<void> {
  const { del } = await import('idb-keyval')
  await del(contactKey(id))
}

export async function pinContact(id: string, pinned: boolean): Promise<void> {
  const contact = await getContact(id)
  if (!contact) return
  await upsertContact({ ...contact, pinnedAt: pinned ? Date.now() : undefined })
}

export async function markContactSent(id: string): Promise<void> {
  const contact = await getContact(id)
  if (!contact) return
  await upsertContact({ ...contact, lastSentAt: Date.now() })
}
