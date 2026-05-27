interface SkeletonProps {
  className?: string
  height?: string | number
  width?: string | number
  rounded?: boolean
}

export function Skeleton({
  className = '',
  height,
  width,
  rounded = false,
}: SkeletonProps) {
  return (
    <div
      className={`skeleton ${rounded ? 'rounded-full' : ''} ${className}`}
      style={{ height, width }}
      aria-hidden="true"
      role="presentation"
    />
  )
}

export function SkeletonText({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height={16}
          width={i === lines - 1 ? '60%' : '100%'}
        />
      ))}
    </div>
  )
}
