import { db, eventCursor } from '../lib/db/index'

async function main() {
  await db.update(eventCursor).set({ lastProcessedBlock: 6464000, updatedAt: Math.floor(Date.now() / 1000) })
  console.log('✅ Cursor reset to block 6464000 — next poll will re-scan the transfer')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
