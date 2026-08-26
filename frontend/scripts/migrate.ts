/**
 * scripts/migrate.ts
 *
 * Applies every SQL migration in ./drizzle in lexical order, exactly once.
 *
 * The previous version had the filename of migration 0000 hard-coded, so any
 * migration added after it was simply never run — which is how
 * `recipient_email` and `email_status` ended up being patched into production
 * by hand from scripts/fix-db-schema.ts. Applied migrations are now recorded in
 * `_migrations`, so this is safe to run on every deploy.
 *
 * Usage:  pnpm db:migrate
 */

import { neon } from '@neondatabase/serverless'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── Load .env without adding a dotenv dependency ─────────────────────────────
const envPath = path.join(process.cwd(), '.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = val
  }
}

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set (checked process.env and ./.env)')
  process.exit(1)
}

/**
 * Neon's HTTP driver only reaches Neon-hosted endpoints, so use `pg` for a
 * local or self-hosted Postgres. Same split as lib/db/index.ts.
 */
const isNeon = /\.neon\.tech|\.neon\.build|neon\.database/i.test(DATABASE_URL)

type QueryFn = (text: string, params?: unknown[]) => Promise<unknown>

let sqlQuery: QueryFn
let closeConnection: () => Promise<void> = async () => {}

if (isNeon) {
  const neonSql = neon(DATABASE_URL)
  sqlQuery = (text, params) => neonSql.query(text, params as never)
} else {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require('pg') as typeof import('pg')
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /sslmode=require/i.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
  })
  sqlQuery = async (text, params) => (await pool.query(text, params as never[])).rows
  closeConnection = () => pool.end()
}

const sql = { query: sqlQuery }

async function ensureLedger() {
  await sql.query(`
    CREATE TABLE IF NOT EXISTS "_migrations" (
      "tag"        text PRIMARY KEY,
      "checksum"   text NOT NULL,
      "applied_at" timestamptz NOT NULL DEFAULT now()
    )
  `)
}

async function appliedTags(): Promise<Map<string, string>> {
  const rows = (await sql.query('SELECT tag, checksum FROM "_migrations"')) as Array<{
    tag: string
    checksum: string
  }>
  return new Map(rows.map(r => [r.tag, r.checksum]))
}

async function main() {
  const dir = path.join(process.cwd(), 'drizzle')
  const files = fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  if (files.length === 0) {
    console.log('No migrations found in ./drizzle')
    return
  }

  await ensureLedger()
  const applied = await appliedTags()

  let ranCount = 0

  for (const file of files) {
    const tag = file.replace(/\.sql$/, '')
    const body = fs.readFileSync(path.join(dir, file), 'utf8')
    const checksum = createHash('sha256').update(body).digest('hex').slice(0, 16)

    const prior = applied.get(tag)
    if (prior) {
      if (prior !== checksum) {
        console.error(
          `Migration ${tag} has already been applied but its contents changed ` +
          `(recorded ${prior}, found ${checksum}).\n` +
          'Never edit an applied migration — add a new one instead.',
        )
        process.exit(1)
      }
      console.log(`  skip  ${tag} (already applied)`)
      continue
    }

    const statements = body
      .split('--> statement-breakpoint')
      .map(s => s.trim())
      .filter(Boolean)

    console.log(`  apply ${tag} — ${statements.length} statements`)

    for (const [i, stmt] of statements.entries()) {
      try {
        await sql.query(stmt)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        // Migrations are written to be idempotent, but ALTER/CREATE races on a
        // partially-applied run can still surface these. They are safe.
        if (/already exists|duplicate|does not exist/i.test(msg)) {
          console.log(`        (${i + 1}/${statements.length}) skipped: ${msg.split('\n')[0]}`)
          continue
        }
        console.error(`\nMigration ${tag} failed at statement ${i + 1}/${statements.length}:`)
        console.error(`  ${msg}`)
        console.error(`  ${stmt.slice(0, 200).replace(/\s+/g, ' ')}…`)
        process.exit(1)
      }
    }

    await sql.query('INSERT INTO "_migrations" (tag, checksum) VALUES ($1, $2)', [tag, checksum])
    ranCount++
  }

  console.log(
    ranCount === 0
      ? '\nDatabase is up to date.'
      : `\nApplied ${ranCount} migration${ranCount === 1 ? '' : 's'}.`,
  )
}

main()
  .then(closeConnection)
  .catch(async e => {
    console.error('Fatal:', e)
    await closeConnection()
    process.exit(1)
  })
