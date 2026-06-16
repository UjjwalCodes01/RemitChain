import { db } from '../lib/db'
import { sql } from 'drizzle-orm'

async function inspect() {
  if (!db) {
    console.log('No DB')
    return
  }
  try {
    const res = await db.execute(sql`
      SELECT table_name, column_name, column_default 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND column_default IS NOT NULL
      ORDER BY table_name, column_name
    `)
    console.log('DEFAULTS:', res.rows)
  } catch (err) {
    console.error('ERROR:', err)
  }
}

inspect().then(() => process.exit(0))
