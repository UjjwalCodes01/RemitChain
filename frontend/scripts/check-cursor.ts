import { getPublicClient } from '../lib/events/listener'
import { db, eventCursor } from '../lib/db'

async function check() {
  const client = getPublicClient()
  const txHash = '0x811595659d2a1b0ba73e3a3e3f00612c43c3570841354f7e76591a387c8a57ba'
  
  try {
    const currentBlock = await client.getBlockNumber()
    console.log('CURRENT BLOCK:', currentBlock.toString())

    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` })
    console.log('TX BLOCK NUMBER:', receipt.blockNumber.toString())

    if (db) {
      const cursorRow = await db.select().from(eventCursor).limit(1)
      console.log('EVENT CURSOR IN DB:', cursorRow)
    } else {
      console.log('NO DB')
    }
  } catch (err) {
    console.error('Error:', err)
  }
}

check().then(() => process.exit(0))
