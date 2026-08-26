/**
 * lib/transfer-id.ts
 *
 * Mirrors `TransferId.generate` from contracts/src/libraries/TransferId.sol:
 *
 *     keccak256(abi.encode(sender, nonce, chainId, address(this)))
 *
 * Kept in one place because both the prepare step and the confirm step derive
 * it, and a mismatch between them would produce an unclaimable transfer.
 */

import { keccak256, encodeAbiParameters, type Hex } from 'viem'

export interface TransferIdInput {
  sender: Hex
  /** The sender's CURRENT nonce — the value consumed by this send. */
  nonce: bigint
  chainId: bigint
  remitChain: Hex
}

export function computeTransferId(input: TransferIdInput): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }],
      [input.sender, input.nonce, input.chainId, input.remitChain],
    ),
  )
}
