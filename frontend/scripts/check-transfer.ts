import { db, transfers } from '../lib/db'
import { eq } from 'drizzle-orm'
import { createPublicClient, http, formatEther } from 'viem'
import { serverChain } from '../lib/chain-config'
import { REMITCHAIN_ADDRESS, RemitChainAbi } from '../lib/contracts'

async function check() {
  const txId = '0x46986200afe2c8766da50365faf26dd8d5c8eb5b5eb70c4245b915a6083d3421'
  
  // 1. DB Row
  try {
    if (db) {
      const row = await db.select().from(transfers).where(eq(transfers.id, txId))
      console.log('DB ROW:', row)
    } else {
      console.log('NO DB')
    }
  } catch (err) {
    console.error('DB ERROR:', err)
  }

  // 2. On-Chain status
  const client = createPublicClient({
    chain: serverChain,
    transport: http(process.env.NEXT_PUBLIC_RPC_URL)
  })

  try {
    console.log('REMITCHAIN_ADDRESS:', REMITCHAIN_ADDRESS)
    console.log('RPC_URL:', process.env.NEXT_PUBLIC_RPC_URL)
    const result = await client.readContract({
      address: REMITCHAIN_ADDRESS as `0x${string}`,
      abi: RemitChainAbi,
      functionName: 'getTransfer',
      args: [txId as `0x${string}`],
    })
    console.log('ON-CHAIN:', result)
    
    const status = await client.readContract({
      address: REMITCHAIN_ADDRESS as `0x${string}`,
      abi: RemitChainAbi,
      functionName: 'getTransferStatus',
      args: [txId as `0x${string}`],
    })
    console.log('ON-CHAIN STATUS:', status)

    const balance = await client.getBalance({
      address: '0x8E1Ea95ecfa447F034bF47f325cb98d7F703a9AC',
    })
    console.log('RELAYER BALANCE:', balance.toString(), 'wei (', formatEther(balance), 'QIE)')
  } catch (err) {
    console.error('ON-CHAIN ERROR:', err)
  }
}

check().then(() => process.exit(0))
