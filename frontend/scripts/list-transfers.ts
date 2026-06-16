import { db, transfers } from '../lib/db'

async function list() {
  if (!db) {
    console.log('No DB')
    return
  }
  try {
    const rows = await db.select().from(transfers).limit(100)
    console.log('TRANSFERS IN DB:', rows)
  } catch (err) {
    console.error('ERROR:', err)
  }
}

list().then(() => process.exit(0))
