import { NextRequest, NextResponse } from 'next/server'
import { db, transfers } from '@/lib/db'
import { eq } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const url = process.env.DATABASE_URL || 'NOT_SET'
  let dbHost = 'unknown'
  try {
    if (url !== 'NOT_SET') {
      const parsed = new URL(url)
      dbHost = parsed.host
    }
  } catch (e) {
    dbHost = 'invalid-url'
  }

  let rowExists = false
  let errorMsg: string | null = null
  let dbContent: any = null

  if (db) {
    try {
      const rows = await db
        .select()
        .from(transfers)
        .where(eq(transfers.id, '0x046db537867ff49871ad6b04191a7cf18d4a1846b70620cc8773f1daef3f4caf'))
        .limit(1)
      if (rows.length > 0) {
        rowExists = true
        dbContent = {
          id: rows[0].id,
          status: rows[0].status,
          amount: rows[0].amount,
        }
      }
    } catch (e: any) {
      errorMsg = e.message || String(e)
    }
  } else {
    errorMsg = 'db is null'
  }

  return NextResponse.json({
    dbHost,
    rowExists,
    dbContent,
    errorMsg,
  })
}
