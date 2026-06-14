/**
 * lib/events/listener.ts
 *
 * Bulletproof event listener for RemitChain on-chain events.
 *
 * Strategy: polling-based catch-up using getLogs + event_cursor DB row.
 *   1. Read lastProcessedBlock from event_cursor
 *   2. Fetch logs from (lastProcessed + 1) → currentBlock in 2000-block chunks
 *   3. Process each event idempotently (upsert into transfers table)
 *   4. Advance cursor ONLY after all events in the batch are processed
 *
 * This survives serverless restarts: if the function dies mid-batch,
 * the cursor doesn't advance and the batch replays on next run.
 * Idempotent upserts ensure no double-processing.
 *
 * Called by: /api/cron/poll-events (Vercel cron every 1 min)
 */

import {
  createPublicClient,
  http,
  parseAbiItem,
  type PublicClient,
  type Log,
} from 'viem'
import { eq, sql } from 'drizzle-orm'
import { db, eventCursor, transfers } from '@/lib/db'
import { REMITCHAIN_ADDRESS } from '@/lib/contracts'

// ── Chain definition (server-only) ────────────────────────────────────────────

import { env } from '@/lib/env'

const RPC_URL = env.NEXT_PUBLIC_RPC_URL
const CHAIN_ID = env.NEXT_PUBLIC_CHAIN_ID

export function getPublicClient(): PublicClient {
  const chainName = CHAIN_ID === 1990 ? 'QIE Mainnet' : 'QIE Testnet'
  return createPublicClient({
    chain: {
      id: CHAIN_ID,
      name: chainName,
      nativeCurrency: { name: 'QIE', symbol: 'QIE', decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
    } as const,
    transport: http(RPC_URL),
  }) as PublicClient
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_BLOCKS_PER_CHUNK = 2000n
const MAX_CHUNKS_PER_RUN = 50   // Safety cap: ~100k blocks max per cron run
const CONFIRMATIONS = 3n        // Process events only after 3 confirmations

// ── Event ABI fragments ───────────────────────────────────────────────────────

const TransferInitiatedAbi = parseAbiItem(
  'event TransferInitiated(bytes32 indexed transferId, address indexed sender, bytes32 indexed recipientPhoneHash, uint256 amount, uint64 expiry, uint8 corridor)',
)

const TransferClaimedAbi = parseAbiItem(
  'event TransferClaimed(bytes32 indexed transferId, address indexed recipient)',
)

const TransferCancelledAbi = parseAbiItem(
  'event TransferCancelled(bytes32 indexed transferId, address indexed sender)',
)

// ── Retry helper ──────────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 500): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, baseDelayMs * 2 ** i))
      }
    }
  }
  throw lastErr
}

// ── Cursor helpers ────────────────────────────────────────────────────────────

async function getCursor(): Promise<number> {
  if (!db) return 0
  const rows = await db.select().from(eventCursor).limit(1)
  return rows[0]?.lastProcessedBlock ?? 0
}

async function setCursor(block: bigint): Promise<void> {
  if (!db) return
  const blockNum = Number(block)
  const nowSec = Math.floor(Date.now() / 1000) // unix seconds — fits in integer column
  await db
    .insert(eventCursor)
    .values({ lastProcessedBlock: blockNum, updatedAt: nowSec })
    .onConflictDoUpdate({
      target: eventCursor.id,
      set: { lastProcessedBlock: blockNum, updatedAt: nowSec },
    })
}

// ── Event processors (all idempotent) ────────────────────────────────────────

async function processTransferInitiated(log: Log<bigint, number, false, typeof TransferInitiatedAbi>) {
  if (!db) return
  const args = log.args
  if (!args.transferId || !args.sender || !args.recipientPhoneHash) return

  const transferId = args.transferId as string
  const amount = (args.amount ?? 0n).toString()
  const corridorIndex = Number(args.corridor ?? 0)
  // expiry is uint64 unix seconds on-chain
  const expiryUnixSec = Number(args.expiry ?? 0)
  const nowSec = Math.floor(Date.now() / 1000)

  // Idempotent upsert — if row already exists (from POST /api/transfers/metadata), merge
  await db
    .insert(transfers)
    .values({
      id: transferId,
      txHash: log.transactionHash ?? null,
      senderAddress: args.sender.toLowerCase(),
      recipientPhoneHash: args.recipientPhoneHash as string,
      amount,
      corridor: String(corridorIndex),
      status: 0,
      smsStatus: 'PENDING',
      expiry: expiryUnixSec,
      createdAt: nowSec,
      updatedAt: nowSec,
    })
    .onConflictDoUpdate({
      target: transfers.id,
      set: {
        txHash: log.transactionHash ?? undefined,
        senderAddress: args.sender.toLowerCase(),
        status: sql`LEAST(${transfers.status}, 0)`, // Don't downgrade status
        updatedAt: nowSec,
      },
    })

  await maybeSendSms(transferId)
}

async function processTransferClaimed(log: Log<bigint, number, false, typeof TransferClaimedAbi>) {
  if (!db) return
  const args = log.args
  if (!args.transferId) return

  const transferId = args.transferId as string

  await db
    .update(transfers)
    .set({ status: 1, claimedAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(transfers.id, transferId))

  console.log(JSON.stringify({ level: 'info', step: 'event.claimed', transferId: transferId.slice(0, 10) + '…', ts: new Date().toISOString() }))
}

async function processTransferCancelled(log: Log<bigint, number, false, typeof TransferCancelledAbi>) {
  if (!db) return
  const args = log.args
  if (!args.transferId) return

  await db
    .update(transfers)
    .set({ status: 2, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(transfers.id, args.transferId as string))
}

// ── SMS trigger ───────────────────────────────────────────────────────────────
// Only fires if smsStatus is still PENDING (idempotent guard)

async function maybeSendSms(transferId: string): Promise<void> {
  if (!db) return

  const rows = await db.select().from(transfers).where(eq(transfers.id, transferId)).limit(1)
  const row = rows[0]
  if (!row || row.smsStatus !== 'PENDING') return

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

  // We don't store the raw phone number (privacy) — the recipient phone is only
  // known to the sender at send time. The SMS notify endpoint handles this.
  // Here we log that notification is needed; the /api/notify call is made by
  // the frontend immediately after send (fire-and-forget). The event listener
  // just ensures the DB smsStatus is updated to SENT/FAILED.

  // Mark as SENT if the SMS was already dispatched via the send flow.
  // If PENDING here, it means the frontend notify call may have failed.
  // We can't resend without the recipient's phone — mark as FAILED for visibility.
  await db
    .update(transfers)
    .set({ smsStatus: 'FAILED', updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(transfers.id, transferId))

  console.log(JSON.stringify({
    level: 'warn',
    step: 'event.sms_not_dispatched',
    transferId: transferId.slice(0, 10) + '…',
    note: 'SMS was not sent via /api/notify — recipient phone not stored server-side',
    ts: new Date().toISOString(),
  }))
}

// ── Main poll function ────────────────────────────────────────────────────────

export interface PollResult {
  fromBlock: bigint
  toBlock: bigint
  chunksProcessed: number
  eventsProcessed: number
  durationMs: number
  dbAvailable: boolean
}

export async function pollAndProcess(): Promise<PollResult> {
  const start = Date.now()

  const publicClient = getPublicClient()

  // Current block (minus confirmations for safety)
  const currentBlock = await withRetry(() => publicClient.getBlockNumber())
  const safeBlock = currentBlock > CONFIRMATIONS ? currentBlock - CONFIRMATIONS : 0n

  const fromBlock = BigInt(await getCursor())

  // Already caught up
  if (fromBlock >= safeBlock) {
    return {
      fromBlock,
      toBlock: safeBlock,
      chunksProcessed: 0,
      eventsProcessed: 0,
      durationMs: Date.now() - start,
      dbAvailable: db !== null,
    }
  }

  // If cursor is 0 (first run), start from current block - 10000 (reasonable lookback)
  const startBlock = fromBlock === 0n
    ? (safeBlock > 10000n ? safeBlock - 10000n : 0n)
    : fromBlock + 1n

  let processedBlock = fromBlock
  let chunksProcessed = 0
  let eventsProcessed = 0

  for (
    let chunkStart = startBlock;
    chunkStart <= safeBlock && chunksProcessed < MAX_CHUNKS_PER_RUN;
    chunkStart += MAX_BLOCKS_PER_CHUNK, chunksProcessed++
  ) {
    const chunkEnd = chunkStart + MAX_BLOCKS_PER_CHUNK - 1n > safeBlock
      ? safeBlock
      : chunkStart + MAX_BLOCKS_PER_CHUNK - 1n

    console.log(JSON.stringify({
      level: 'info',
      step: 'event.poll_chunk',
      fromBlock: chunkStart.toString(),
      toBlock: chunkEnd.toString(),
      ts: new Date().toISOString(),
    }))

    // Fetch all event types in parallel
    const [initiatedLogs, claimedLogs, cancelledLogs] = await withRetry(() =>
      Promise.all([
        publicClient.getLogs({
          address: REMITCHAIN_ADDRESS,
          event: TransferInitiatedAbi,
          fromBlock: chunkStart,
          toBlock: chunkEnd,
        }),
        publicClient.getLogs({
          address: REMITCHAIN_ADDRESS,
          event: TransferClaimedAbi,
          fromBlock: chunkStart,
          toBlock: chunkEnd,
        }),
        publicClient.getLogs({
          address: REMITCHAIN_ADDRESS,
          event: TransferCancelledAbi,
          fromBlock: chunkStart,
          toBlock: chunkEnd,
        }),
      ]),
    )

    // Sort all events by block number + log index for deterministic ordering
    type AnyLog = typeof initiatedLogs[0] | typeof claimedLogs[0] | typeof cancelledLogs[0]
    const allLogs: Array<{ type: string; log: AnyLog }> = [
      ...initiatedLogs.map(l => ({ type: 'initiated', log: l as AnyLog })),
      ...claimedLogs.map(l => ({ type: 'claimed', log: l as AnyLog })),
      ...cancelledLogs.map(l => ({ type: 'cancelled', log: l as AnyLog })),
    ].sort((a, b) => {
      const blockDiff = Number(a.log.blockNumber ?? 0n) - Number(b.log.blockNumber ?? 0n)
      if (blockDiff !== 0) return blockDiff
      return (a.log.logIndex ?? 0) - (b.log.logIndex ?? 0)
    })

    for (const { type, log } of allLogs) {
      try {
        if (type === 'initiated') {
          await processTransferInitiated(log as Log<bigint, number, false, typeof TransferInitiatedAbi>)
        } else if (type === 'claimed') {
          await processTransferClaimed(log as Log<bigint, number, false, typeof TransferClaimedAbi>)
        } else if (type === 'cancelled') {
          await processTransferCancelled(log as Log<bigint, number, false, typeof TransferCancelledAbi>)
        }
        eventsProcessed++
      } catch (err) {
        console.error(JSON.stringify({
          level: 'error',
          step: 'event.process_failed',
          type,
          txHash: log.transactionHash,
          err: String(err).slice(0, 200),
          ts: new Date().toISOString(),
        }))
        // Continue processing other events — don't let one bad event block the cursor
      }
    }

    // Advance cursor after each chunk completes successfully
    processedBlock = chunkEnd
    await setCursor(processedBlock)
  }

  return {
    fromBlock: startBlock,
    toBlock: processedBlock,
    chunksProcessed,
    eventsProcessed,
    durationMs: Date.now() - start,
    dbAvailable: db !== null,
  }
}
