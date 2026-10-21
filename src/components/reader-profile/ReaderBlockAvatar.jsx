import { useEffect, useState } from 'react'
import { UserRound } from 'lucide-react'

export default function ReaderBlockAvatar({ src, name = '', size = 'md' }) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [src])

  const dimensions = size === 'lg' ? 'h-14 w-14' : 'h-10 w-10'
  const iconSize = size === 'lg' ? 26 : 20

  return (
    <span className={`flex ${dimensions} shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--shadow-bg-soft)] text-[var(--shadow-text-secondary)]`}>
      {src && !failed ? (
        <img
          src={src}
          alt={name}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <UserRound size={iconSize} strokeWidth={1.6} aria-hidden="true" />
      )}
    </span>
  )
}
