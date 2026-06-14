// Error message map: EVM revert reasons → plain English
// Add new entries as new reverts are discovered.

const ERROR_MAP: Record<string, string> = {
  // ERC20
  'transfer amount exceeds balance': 'Not enough QUSD in your wallet.',
  'insufficient allowance': 'Please approve QUSD spending first.',
  'ERC20: transfer amount exceeds balance': 'Not enough QUSD in your wallet.',
  'ERC20: insufficient allowance': 'Please approve QUSD spending first.',

  // RemitChain custom errors
  TransferExpired: 'This transfer has expired. The sender can reclaim their funds.',
  TransferNotFound: 'Transfer not found. Check the transfer ID.',
  TransferNotPending: 'This transfer is no longer pending.',
  InvalidOTPReveal: 'Incorrect code. Please try again.',
  InvalidRecipientSignature: 'Signature verification failed.',
  AmountBelowMinimum: 'Minimum transfer amount is 1 QUSD.',
  ZeroAddress: 'Invalid address provided.',
  UnauthorizedCancel: 'Only the sender can cancel before expiry.',
  SignatureExpired: 'The claim window has expired.',

  // KYCRegistry
  KYCLevelInsufficient: 'Your KYC level is too low for this amount.',
  DailyLimitExceeded: 'Daily transfer limit reached. Try again tomorrow.',
  UserNotVerified: 'Identity verification required before sending.',

  // Network
  'user rejected': 'Transaction cancelled.',
  'User rejected': 'Transaction cancelled.',
  'user denied': 'Transaction cancelled.',
  'User denied': 'Transaction cancelled.',
  'chain mismatch': 'Please switch to QIE Mainnet.',
  CALL_EXCEPTION: 'The transaction was rejected by the contract.',
  INSUFFICIENT_FUNDS: 'Not enough QIE to cover gas.',
}

/**
 * Maps a raw Error or error message to a user-friendly string.
 * Falls back to a generic message if no mapping is found.
 */
export function mapError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error'

  for (const [key, friendly] of Object.entries(ERROR_MAP)) {
    if (raw.includes(key)) return friendly
  }

  // Trim long messages to avoid wall-of-text
  if (raw.length > 120) return raw.slice(0, 120) + '…'
  return raw
}
