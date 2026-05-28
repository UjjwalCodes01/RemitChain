'use client'
import { useConnect, useAccount, useDisconnect } from 'wagmi'

export function ConnectButton() {
  const { connect, connectors, isPending } = useConnect()
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()

  if (isConnected) {
    return (
      <button onClick={() => disconnect()}
        className="px-4 py-2 rounded-full bg-surface text-sm font-mono">
        {address?.slice(0,6)}...{address?.slice(-4)}
      </button>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {connectors.map(connector => (
        <button
          key={connector.id}
          onClick={() => connect({ connector })}
          disabled={isPending}
          className="w-full p-4 rounded-2xl bg-surface active:scale-95 transition-transform flex items-center gap-3 min-h-[56px]">
          <span className="font-medium">
            {connector.name === 'WalletConnect' 
              ? '📱 Connect Wallet App' 
              : '🔗 Browser Wallet'}
          </span>
        </button>
      ))}
    </div>
  )
}
