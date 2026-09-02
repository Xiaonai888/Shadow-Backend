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

function handleReaderSessionResponse(fetchPromise) {
  return fetchPromise.then((response) => {
    const renewedToken =
      response.headers.get('X-Reader-Token')

    if (renewedToken) {
      if (
        sessionStorage.getItem(
          'shadow_reader_token'
        )
      ) {
        sessionStorage.setItem(
          'shadow_reader_token',
          renewedToken
        )
      }

      if (
        localStorage.getItem(
          'shadow_reader_token'
        )
      ) {
        localStorage.setItem(
          'shadow_reader_token',
          renewedToken
        )
      }
    }

    return response
  })
}

export function installApiAuthFetch() {
  if (window.__shadowApiAuthFetchInstalled) return

  window.__shadowApiAuthFetchInstalled = true

  const nativeFetch = window.fetch.bind(window)

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

    const token =
      sessionStorage.getItem('shadow_reader_token') ||
      localStorage.getItem('shadow_reader_token') ||
      ''

    if (!token) {
      return nativeFetch(input, init)
    }

    const headers = new Headers(
      input instanceof Request
        ? input.headers
        : undefined
    )

    new Headers(init.headers || {}).forEach(
      (value, key) => {
        headers.set(key, value)
      }
    )

    if (!headers.has('Authorization')) {
      headers.set(
        'Authorization',
        `Bearer ${token}`
      )
    }

    if (input instanceof Request) {
      return handleReaderSessionResponse(
        nativeFetch(
          new Request(input, {
            ...init,
            headers,
          })
        )
      )
    }

    return handleReaderSessionResponse(
      nativeFetch(input, {
        ...init,
        headers,
      })
    )
  }
}
