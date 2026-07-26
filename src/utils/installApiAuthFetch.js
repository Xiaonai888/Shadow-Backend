const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  (window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1'
    ? 'http://localhost:5000'
    : 'https://shadow-backend-kucw.onrender.com')

const API_ORIGIN = new URL(
  API_BASE_URL,
  window.location.origin
).origin

const VISITOR_STORAGE_KEY = 'shadow_visitor_id'
let memoryVisitorId = ''

function createVisitorId() {
  if (
    window.crypto &&
    typeof window.crypto.randomUUID === 'function'
  ) {
    return `visitor:${window.crypto.randomUUID()}`
  }

  const randomPart = Math.random()
    .toString(36)
    .slice(2, 14)

  return `visitor:${Date.now().toString(36)}:${randomPart}`
}

function getVisitorId() {
  if (memoryVisitorId) return memoryVisitorId

  try {
    const saved = localStorage.getItem(
      VISITOR_STORAGE_KEY
    )

    if (
      saved &&
      /^[a-zA-Z0-9._:-]{6,200}$/.test(saved)
    ) {
      memoryVisitorId = saved
      return saved
    }

    const created = createVisitorId()

    localStorage.setItem(
      VISITOR_STORAGE_KEY,
      created
    )

    memoryVisitorId = created
    return created
  } catch {
    memoryVisitorId = createVisitorId()
    return memoryVisitorId
  }
}

function getReaderToken() {
  return (
    sessionStorage.getItem(
      'shadow_reader_token'
    ) ||
    localStorage.getItem(
      'shadow_reader_token'
    ) ||
    ''
  )
}

export function installApiAuthFetch() {
  if (
    window.__shadowApiAuthFetchInstalled
  ) {
    return
  }

  window.__shadowApiAuthFetchInstalled = true

  const nativeFetch =
    window.fetch.bind(window)

  window.fetch = (input, init = {}) => {
    const requestUrl =
      input instanceof Request
        ? input.url
        : String(input)

    const url = new URL(
      requestUrl,
      window.location.origin
    )

    if (url.origin !== API_ORIGIN) {
      return nativeFetch(input, init)
    }

    const headers = new Headers(
      input instanceof Request
        ? input.headers
        : undefined
    )

    new Headers(
      init.headers || {}
    ).forEach((value, key) => {
      headers.set(key, value)
    })

    const token = getReaderToken()
    const visitorId = getVisitorId()

    if (
      token &&
      !headers.has('Authorization')
    ) {
      headers.set(
        'Authorization',
        `Bearer ${token}`
      )
    }

    if (
      visitorId &&
      !headers.has(
        'X-Shadow-Visitor-Id'
      )
    ) {
      headers.set(
        'X-Shadow-Visitor-Id',
        visitorId
      )
    }

    if (input instanceof Request) {
      return nativeFetch(
        new Request(input, {
          ...init,
          headers,
        })
      )
    }

    return nativeFetch(input, {
      ...init,
      headers,
    })
  }
}
