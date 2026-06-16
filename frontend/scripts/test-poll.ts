import { getPublicClient } from '../lib/events/listener'
import { parseAbiItem } from 'viem'
import { REMITCHAIN_ADDRESS } from '../lib/contracts'

const TransferInitiatedAbi = parseAbiItem(
  'event TransferInitiated(bytes32 indexed transferId, address indexed sender, bytes32 indexed recipientPhoneHash, uint256 amount, uint64 expiry, uint8 corridor)',
)

async function test() {
  const client = getPublicClient()
  console.log('REMITCHAIN_ADDRESS:', REMITCHAIN_ADDRESS)
  try {
    const logs = await client.getLogs({
      address: REMITCHAIN_ADDRESS,
      event: TransferInitiatedAbi,
      fromBlock: 8593000n,
      toBlock: 8593010n,
    })
    console.log('Logs found in range:', logs.length)
    for (const log of logs) {
      console.log('Log args:', {
        transferId: log.args.transferId,
        sender: log.args.sender,
        recipientPhoneHash: log.args.recipientPhoneHash,
        amount: log.args.amount?.toString(),
        expiry: log.args.expiry?.toString(),
        corridor: log.args.corridor,
      })
    }
  } catch (err) {
    console.error('Error fetching logs:', err)
  }
}

test().then(() => process.exit(0))
