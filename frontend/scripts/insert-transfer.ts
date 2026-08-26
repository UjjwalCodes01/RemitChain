/**
 * scripts/insert-transfer.ts
 *
 * Seeds one transfer row for local UI work. Development only — it writes a
 * record with no on-chain counterpart, so never point it at production.
 *
 * Usage:  pnpm tsx scripts/insert-transfer.ts
 */

import { db, transfers } from '../lib/db'

async function run() {
  if (!db) {
    console.log('DATABASE_URL is not set — nothing to do.')
    return
  }

  if (process.env.NEXT_PUBLIC_CHAIN_ID === '1990') {
    console.error('Refusing to seed fake data against a production chain.')
    process.exit(1)
  }

  const txId = '0x46986200afe2c8766da50365faf26dd8d5c8eb5b5eb70c4245b915a6083d3421'
  // Every timestamp in this schema is epoch MILLISECONDS.
  const now = Date.now()
  const twoHoursAgo = now - 2 * 60 * 60 * 1000

  try {
    await db.insert(transfers).values({
      id: txId,
      txHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      senderAddress: '0x8e1ea95ecfa447f034bf47f325cb98d7f703a9ac',
      recipientPhoneHash: '0x0045df2a850bd6734d31d694631e1b61e9576898bb2c341969d1106848f82340',
      recipientPhoneMasked: '+91•••••3210',
      recipientNickname: 'Ujjwal',
      amount: '100000000',      // 100 QUSD
      feeAmount: '100000',      // 0.1%
      netAmount: '99900000',
      corridor: 'ae-in',
      quotedRate: '83.45',
      quotedCurrency: 'INR',
      quotedLocalMinor: '833665500',
      quotedAt: twoHoursAgo,
      status: 0,
      notifyChannel: 'email',
      notifyStatus: 'SENT',
      recipientEmail: null,
      createdAt: twoHoursAgo,
      updatedAt: twoHoursAgo,
      expiry: now + 46 * 60 * 60 * 1000, // ~46h left on the 48h window
    })
    console.log('Seeded transfer', txId)
  } catch (err) {
    console.error('Insert failed:', err)
    process.exitCode = 1
  }
}

run().then(() => process.exit(process.exitCode ?? 0))
