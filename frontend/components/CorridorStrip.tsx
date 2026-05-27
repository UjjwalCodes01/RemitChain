const CORRIDORS = [
  { from: '🇦🇪', fromName: 'UAE', to: '🇮🇳', toName: 'India', oldFee: '3.8%', newFee: '0.1%', rail: 'UPI' },
  { from: '🇺🇸', fromName: 'USA', to: '🇲🇽', toName: 'Mexico', oldFee: '3.1%', newFee: '0.1%', rail: 'SPEI' },
  { from: '🇬🇧', fromName: 'UK', to: '🇳🇬', toName: 'Nigeria', oldFee: '5.8%', newFee: '0.1%', rail: 'Opay' },
  { from: '🇸🇦', fromName: 'Saudi', to: '🇵🇰', toName: 'Pakistan', oldFee: '4.9%', newFee: '0.1%', rail: 'JazzCash' },
  { from: '🇸🇬', fromName: 'Singapore', to: '🇧🇩', toName: 'Bangladesh', oldFee: '5.1%', newFee: '0.1%', rail: 'bKash' },
  { from: '🇬🇧', fromName: 'UK', to: '🇵🇭', toName: 'Philippines', oldFee: '4.2%', newFee: '0.1%', rail: 'GCash' },
]

export function CorridorStrip() {
  return (
    <div className="overflow-x-auto pb-2 -mx-4 px-4">
      <div className="flex gap-3 min-w-max mx-auto justify-center flex-wrap">
        {CORRIDORS.map((c) => (
          <div
            key={`${c.fromName}-${c.toName}`}
            className="flex items-center gap-3 rounded-xl px-4 py-3 border shrink-0"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-border)',
            }}
          >
            {/* Flag pair */}
            <span
              className="text-xl leading-none"
              aria-label={`${c.fromName} to ${c.toName}`}
            >
              {c.from}→{c.to}
            </span>

            {/* Fee comparison */}
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5 text-sm">
                <span
                  className="line-through text-xs"
                  style={{ color: 'var(--color-text-tertiary)' }}
                  aria-label={`Old fee: ${c.oldFee}`}
                >
                  {c.oldFee}
                </span>
                <span
                  className="font-bold"
                  style={{ color: 'var(--color-mint)' }}
                  aria-label={`New fee: ${c.newFee}`}
                >
                  {c.newFee}
                </span>
              </div>
              <span
                className="text-xs"
                style={{ color: 'var(--color-text-tertiary)' }}
              >
                via {c.rail}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
