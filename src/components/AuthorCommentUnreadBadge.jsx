import { useEffect, useState } from 'react'

const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  (window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1'
    ? 'http://localhost:5000'
    : 'https://shadow-backend-kucw.onrender.com')

function getReaderToken() {
  return (
    localStorage.getItem('shadow_reader_token') ||
    sessionStorage.getItem('shadow_reader_token') ||
    ''
  )
}

export default function AuthorCommentUnreadBadge({ enabled }) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setCount(0)
      return
    }

    const token = getReaderToken()
    if (!token) return

    let ignore = false

    async function loadCount() {
      try {
        const response = await fetch(
          `${API_BASE_URL}/api/comments/me/author-unread-count`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
            cache: 'no-store',
          }
        )

        const data = await response.json().catch(() => ({}))

        if (
          !ignore &&
          response.ok &&
          data.ok !== false
        ) {
          setCount(
            Math.max(
              0,
              Number(data.unread_count || 0)
            )
          )
        }
      } catch {}
    }

    loadCount()

    return () => {
      ignore = true
    }
  }, [enabled])

  if (!enabled || count <= 0) return null

  return (
    <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#ef4444] px-1.5 text-[10px] font-extrabold leading-none text-white">
      {count > 99 ? '99+' : count}
    </span>
  )
}
