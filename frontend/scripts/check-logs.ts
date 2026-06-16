import { getPublicClient } from '../lib/events/listener'

async function check() {
  const client = getPublicClient()
  const txHash = '0x811595659d2a1b0ba73e3a3e3f00612c43c3570841354f7e76591a387c8a57ba'
  
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` })
    console.log('TX Receipt logs:', JSON.stringify(receipt.logs, (key, value) => {
      if (typeof value === 'bigint') {
        return value.toString()
      }
      return value
    }, 2))
  } catch (err) {
    console.error('Error:', err)
  }
}

check().then(() => process.exit(0))
