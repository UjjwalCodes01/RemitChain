import { neon } from '@neondatabase/serverless'

async function run() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set')
    process.exit(1)
  }

  const sql = neon(url)

  console.log('Adding missing columns to transfers table...')
  try {
    await sql`ALTER TABLE transfers ADD COLUMN IF NOT EXISTS recipient_email text;`
    await sql`ALTER TABLE transfers ADD COLUMN IF NOT EXISTS email_status text DEFAULT 'PENDING';`
    console.log('Columns added successfully!')
  } catch (err) {
    console.error('Failed to alter table:', err)
  }
}

run().then(() => process.exit(0))
