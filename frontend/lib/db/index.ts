/**
 * lib/db/index.ts
 *
 * Neon serverless Postgres client + Drizzle ORM instance.
 *
 * Graceful degradation: if DATABASE_URL is absent (local dev without credentials),
 * `db` is null and all callers must handle the null case — no crash on boot.
 * Every route that uses the DB checks `if (!db)` and falls back to a stub response.
 */

import { drizzle } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'
import * as schema from './schema'

// ── Singleton DB instance ────────────────────────────────────────────────────

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

function getDb() {
  if (_db) return _db

  const url = process.env.DATABASE_URL
  if (!url) {
    console.warn('[DB] DATABASE_URL not set — running without database persistence')
    return null
  }

  try {
    const sql = neon(url)
    _db = drizzle(sql, { schema })
    return _db
  } catch (err) {
    console.error('[DB] Failed to initialise Neon client:', err)
    return null
  }
}

export const db = getDb()

// Re-export schema for convenience
export * from './schema'

// ── Helper: check if DB is available ────────────────────────────────────────
export function isDbAvailable(): boolean {
  return db !== null
}
