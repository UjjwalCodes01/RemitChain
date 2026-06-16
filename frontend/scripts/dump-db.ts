import { db, transfers } from '../lib/db'
import { desc } from 'drizzle-orm'

async function dump() {
  if (!db) {
    console.error('No DB connection!')
    process.exit(1)
  }
  try {
    const rows = await db.select().from(transfers).orderBy(desc(transfers.createdAt)).limit(10)
    console.log('LAST 10 TRANSERS IN DB:')
    console.log(JSON.stringify(rows, null, 2))
  } catch (err) {
    console.error('Error fetching from DB:', err)
  }
}

dump().then(() => process.exit(0))
