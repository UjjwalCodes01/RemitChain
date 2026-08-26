/**
 * lib/db/index.ts
 *
 * Drizzle ORM instance, backed by Neon in production and by a plain Postgres
 * connection anywhere else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY TWO DRIVERS
 * ─────────────────────────────────────────────────────────────────────────────
 * `@neondatabase/serverless` talks to Neon over HTTP. That is the right choice
 * on Vercel — no connection pool to exhaust across serverless invocations — but
 * it cannot reach a Postgres server over TCP, which meant the whole application
 * was impossible to run end to end against a local database. Anything involving
 * the payout ledger could only be tested against production infrastructure.
 *
 * The driver is now chosen from the connection string: Neon hosts use the HTTP
 * driver, everything else uses `pg`. `pg` is a devDependency and is imported
 * lazily, so it is never pulled into a Vercel function bundle.
 *
 * Graceful degradation is preserved: with no DATABASE_URL, `db` is null and
 * callers fall back. On a production chain `lib/env.server.ts` makes
 * DATABASE_URL mandatory, so that path cannot be reached there.
 */

import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'
import * as schema from './schema'

type DrizzleDb = ReturnType<typeof drizzleNeon<typeof schema>>

let _db: DrizzleDb | null = null

/** Neon's HTTP driver only works against Neon-hosted endpoints. */
function isNeonUrl(url: string): boolean {
  return /\.neon\.tech|\.neon\.build|neon\.database/i.test(url)
}

function getDb(): DrizzleDb | null {
  if (_db) return _db

  const url = process.env.DATABASE_URL
  if (!url) {
    console.warn('[DB] DATABASE_URL not set — running without database persistence')
    return null
  }

  try {
    if (isNeonUrl(url)) {
      _db = drizzleNeon(neon(url), { schema })
      return _db
    }

    // Local or self-hosted Postgres. Required lazily so `pg` never has to be
    // resolvable in a serverless build that only ever talks to Neon.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require('pg') as typeof import('pg')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { drizzle: drizzleNode } = require('drizzle-orm/node-postgres') as typeof import('drizzle-orm/node-postgres')

    const pool = new Pool({
      connectionString: url,
      // Local development is typically plain TCP with no TLS.
      ssl: /sslmode=require/i.test(url) ? { rejectUnauthorized: false } : undefined,
      max: 5,
    })

    _db = drizzleNode(pool, { schema }) as unknown as DrizzleDb
    console.warn('[DB] Using the node-postgres driver — intended for local development only')
    return _db
  } catch (err) {
    console.error('[DB] Failed to initialise the database client:', err)
    return null
  }
}

export const db = getDb()

// Re-export schema for convenience
export * from './schema'

/** True when a database connection is configured. */
export function isDbAvailable(): boolean {
  return db !== null
}
