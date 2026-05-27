export interface RecurringSchedule {
  id: string
  ownerAddress: string
  contactId: string
  contactName: string
  amount: number
  corridorId: string
  frequency: 'weekly' | 'monthly' | 'custom'
  dayOfMonth?: number    // for monthly
  nextRunAt: number      // unix timestamp ms
  active: boolean
  createdAt: number
  lastRunAt?: number
}

export type NewSchedule = Omit<RecurringSchedule, 'id' | 'createdAt'>
