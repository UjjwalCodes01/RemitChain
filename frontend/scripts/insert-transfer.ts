import { db, transfers } from '../lib/db'

async function run() {
  if (!db) {
    console.log('No DB')
    return
  }
  const txId = '0x46986200afe2c8766da50365faf26dd8d5c8eb5b5eb70c4245b915a6083d3421'
  const nowSec = Math.floor(Date.now() / 1000)
  try {
    await db.insert(transfers).values({
      id: txId,
      txHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      senderAddress: '0x8e1ea95ecfa447f034bf47f325cb98d7f703a9ac',
      recipientPhoneHash: '0x0045df2a850bd6734d31d694631e1b61e9576898bb2c341969d1106848f82340',
      recipientNickname: 'Ujjwal',
      amount: '100000000',
      corridor: 'ae-in',
      status: 0,
      offrampStatus: 'NONE',
      smsStatus: 'SENT',
      recipientEmail: null,
      emailStatus: 'PENDING',
      createdAt: nowSec - 3600 * 2, // 2 hours ago
      updatedAt: nowSec - 3600 * 2,
      expiry: 1781727513, // seconds
    })
    console.log('Successfully inserted transfer into DB!')
  } catch (err) {
    console.error('Insert failed:', err)
  }
}

run().then(() => process.exit(0))
