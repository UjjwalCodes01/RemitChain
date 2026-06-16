import { neon } from '@neondatabase/serverless'
import * as fs from 'fs'
import * as path from 'path'

// Load .env manually (no dotenv dependency needed)
const envPath = path.join(process.cwd(), '.env')
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = val
  }
}

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set in .env')
  process.exit(1)
}

const sql = neon(DATABASE_URL)

async function main() {
  const migrationPath = path.join(process.cwd(), 'drizzle', '0000_deep_medusa.sql')
  const sqlText = fs.readFileSync(migrationPath, 'utf8')

  // Split on drizzle-kit statement breakpoints
  const statements = sqlText
    .split('--> statement-breakpoint')
    .map(s => s.trim())
    .filter(Boolean)

  console.log(`📦 Running ${statements.length} SQL statements...`)

  let ok = 0
  let skipped = 0
  for (const stmt of statements) {
    try {
      await sql.query(stmt)
      ok++
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      // "already exists" errors are safe to skip
      if (msg.includes('already exists') || msg.includes('duplicate')) {
        console.log(`⏭  Skip (already exists): ${stmt.slice(0, 60).replace(/\n/g, ' ')}...`)
        skipped++
      } else {
        console.error(`❌ Failed: ${msg}`)
        console.error(`   Statement: ${stmt.slice(0, 120)}`)
        process.exit(1)
      }
    }
  }

  console.log(`\n✅ Migration complete: ${ok} applied, ${skipped} skipped`)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
