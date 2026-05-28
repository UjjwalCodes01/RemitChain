/**
 * __tests__/relayer.test.ts
 *
 * Unit tests for the relayer claim logic.
 * All viem network calls are mocked — no real RPC required.
 *
 * Tests:
 *  1. Happy path  — correct OTP + phone → success
 *  2. Wrong OTP   — commit-reveal mismatch → 400
 *  3. Wrong phone — phone hash mismatch → 400
 *  4. 4th attempt locked — 3 failures then 4th → 429
 *  5. Replay attack — transfer status CLAIMED → idempotent 200, no broadcast
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { encodeAbiParameters, encodePacked, keccak256, toHex } from 'viem'
import { computePhoneHash, computeOtpCommitHash, PHONE_SALT } from '@/lib/relayer/claim'

// ── Helpers (mirror the send page logic) ─────────────────────────────────────

const RELAYER_ADDRESS = '0x57B459fE76d0Db566E3CA71B3CED6F949539Fb39' as const
const TEST_PHONE = '+919876543210'
const TEST_OTP = '123456'
const TEST_TRANSFER_ID = ('0x' + 'ab'.repeat(32)) as `0x${string}`

function makeOtpReveal(otp: string): `0x${string}` {
  return toHex(BigInt(otp), { size: 32 })
}

function makeOtpCommitHash(otp: string, transferId: `0x${string}`): `0x${string}` {
  return computeOtpCommitHash(makeOtpReveal(otp), transferId, RELAYER_ADDRESS)
}

function makePhoneHash(phone: string): `0x${string}` {
  return computePhoneHash(phone)
}

// ── Mock the HTTP route environment ──────────────────────────────────────────
// We test the route handler logic by importing and calling it directly after
// mocking viem's createPublicClient and createWalletClient.

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: vi.fn(),
    createWalletClient: vi.fn(),
  }
})

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_CHAIN_ID: 1983,
    NEXT_PUBLIC_RPC_URL: 'https://rpc1testnet.qie.digital/',
    // Inline literal — vi.mock factories are hoisted, cannot reference outer consts
    NEXT_PUBLIC_RELAYER_ADDRESS: '0x57B459fE76d0Db566E3CA71B3CED6F949539Fb39',
    RELAYER_PRIVATE_KEY: '0x' + 'ff'.repeat(32),
  },
}))

vi.mock('@/lib/relayer/claim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relayer/claim')>()
  return {
    ...actual,
    // keep pure helpers from actual; mock only the network-dependent broadcast
    buildAndBroadcastClaim: vi.fn().mockResolvedValue({ txHash: '0x1234' }),
  }
})

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn().mockReturnValue({
    // Inline literal to avoid hoisting TDZ
    address: '0x57B459fE76d0Db566E3CA71B3CED6F949539Fb39',
    signTypedData: vi.fn(),
  }),
}))

// ── Test factory: build a transfer struct ────────────────────────────────────

function makeTransfer(overrides: Partial<{
  status: number
  recipientPhoneHash: `0x${string}`
  otpCommitHash: `0x${string}`
  expiry: bigint
}> = {}) {
  return {
    sender: '0xSender' as `0x${string}`,
    recipientPhoneHash: overrides.recipientPhoneHash ?? makePhoneHash(TEST_PHONE),
    otpCommitHash: overrides.otpCommitHash ?? makeOtpCommitHash(TEST_OTP, TEST_TRANSFER_ID),
    amount: BigInt(5_000_000), // 5 QUSD (6 decimals)
    expiry: overrides.expiry ?? BigInt(Math.floor(Date.now() / 1000) + 172800), // +48h
    corridor: 1,
    status: overrides.status ?? 0, // PENDING
  }
}

// ── Import route handler after mocks are set up ───────────────────────────────

// We call the POST handler function directly for fast unit testing
// without spinning up a Next.js server.
async function callRoute(body: unknown, mockTransfer: ReturnType<typeof makeTransfer>) {
  // Set up mock public client that returns our fake transfer
  const { createPublicClient } = await import('viem')
  ;(createPublicClient as ReturnType<typeof vi.fn>).mockReturnValue({
    readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
      if (functionName === 'getTransfer') return Promise.resolve(mockTransfer)
      if (functionName === 'recipientNonces') return Promise.resolve(BigInt(0))
      return Promise.resolve(null)
    }),
    simulateContract: vi.fn().mockResolvedValue({ request: {} }),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({}),
  })

  const { createWalletClient } = await import('viem')
  ;(createWalletClient as ReturnType<typeof vi.fn>).mockReturnValue({
    signTypedData: vi.fn().mockResolvedValue('0xsig'),
    writeContract: vi.fn().mockResolvedValue('0x1234'),
  })

  // Dynamically import handler (picks up mocks)
  const { POST } = await import('@/app/api/relayer/claim/route')

  const req = {
    json: async () => body,
    headers: { get: () => null },
  } as unknown as import('next/server').NextRequest

  return POST(req)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('relayer /api/relayer/claim', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the rate-limit map between tests by re-importing the module
    // (vitest caches modules so we reset via the mock)
  })

  it('1. happy path — correct OTP + phone → 200 success', async () => {
    const res = await callRoute(
      { transferId: TEST_TRANSFER_ID, otp: TEST_OTP, recipientPhone: TEST_PHONE },
      makeTransfer(),
    )
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.txHash).toBeTruthy()
    expect(data.idempotent).toBeUndefined()
  })

  it('2. wrong OTP — commit-reveal mismatch → 400', async () => {
    const res = await callRoute(
      { transferId: TEST_TRANSFER_ID, otp: '999999', recipientPhone: TEST_PHONE },
      makeTransfer(), // has commitHash for OTP 123456
    )
    const data = await res.json()
    expect(res.status).toBe(400)
    expect(data.error).toMatch(/otp|invalid/i)
  })

  it('3. wrong phone — phone hash mismatch → 400', async () => {
    const res = await callRoute(
      { transferId: TEST_TRANSFER_ID, otp: TEST_OTP, recipientPhone: '+15005550006' },
      makeTransfer(), // has phoneHash for TEST_PHONE
    )
    const data = await res.json()
    expect(res.status).toBe(400)
    expect(data.error).toMatch(/phone/i)
  })

  it('4. 4th attempt locked — 3 bad attempts then 4th → 429', async () => {
    // 3 failures (wrong phone → phone hash mismatch)
    for (let i = 0; i < 3; i++) {
      await callRoute(
        { transferId: TEST_TRANSFER_ID, otp: '000000', recipientPhone: TEST_PHONE },
        makeTransfer(),
      )
    }
    // 4th attempt — even with correct creds — should be locked
    const res = await callRoute(
      { transferId: TEST_TRANSFER_ID, otp: TEST_OTP, recipientPhone: TEST_PHONE },
      makeTransfer(),
    )
    const data = await res.json()
    expect(res.status).toBe(429)
    expect(data.retryAfterMs).toBeGreaterThan(0)
  })

  it('5. replay attack — transfer already CLAIMED → idempotent 200, broadcast NOT called', async () => {
    const { buildAndBroadcastClaim } = await import('@/lib/relayer/claim')
    // Use a fresh transferId so rate-limit state from test 4 doesn't interfere
    const freshId = ('0x' + 'cd'.repeat(32)) as `0x${string}`

    const res = await callRoute(
      { transferId: freshId, otp: TEST_OTP, recipientPhone: TEST_PHONE },
      makeTransfer({ status: 1 }), // CLAIMED
    )
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.idempotent).toBe(true)
    expect(data.txHash).toBeNull()
    expect(buildAndBroadcastClaim).not.toHaveBeenCalled()
  })
})

// ── Pure logic unit tests (no mocks needed) ───────────────────────────────────

describe('computePhoneHash', () => {
  it('matches abi.encodePacked(SALT, phone) encoding', () => {
    // Verify our helper produces the same hash the send page does
    const phone = '+919876543210'
    const hash = computePhoneHash(phone)
    // Re-derive manually using the same ingredients
    const manual = keccak256(encodePacked(['bytes32', 'string'], [PHONE_SALT, phone]))
    expect(hash).toBe(manual)
  })
})

describe('computeOtpCommitHash', () => {
  it('matches abi.encode(otpReveal, transferId, relayer) encoding', () => {
    const otp = '654321'
    const transferId = TEST_TRANSFER_ID
    const otpReveal = makeOtpReveal(otp)
    const hash = computeOtpCommitHash(otpReveal, transferId, RELAYER_ADDRESS)
    // Re-derive manually
    const manual = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }],
        [otpReveal, transferId, RELAYER_ADDRESS],
      ),
    )
    expect(hash).toBe(manual)
  })
})
