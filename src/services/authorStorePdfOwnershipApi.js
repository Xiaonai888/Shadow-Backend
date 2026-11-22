const API_URL = import.meta.env.VITE_API_URL ||
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:5000'
    : 'https://shadow-backend-kucw.onrender.com')

function readerToken() {
  return localStorage.getItem('shadow_reader_token') || sessionStorage.getItem('shadow_reader_token') || ''
}

export function hasAuthorStoreReaderSession() {
  return Boolean(readerToken())
}

export async function fetchAuthorStorePdfOwnership(productIds, { signal } = {}) {
  const token = readerToken()
  if (!token) return { authenticated: false, products: [] }

  const ids = [...new Set((Array.isArray(productIds) ? productIds : [])
    .map((id) => String(id || '').trim()).filter(Boolean))]
  if (!ids.length) return { authenticated: true, products: [] }
  if (ids.length > 30) throw new Error('Too many PDF products to verify.')

  const response = await fetch(
    `${API_URL}/api/author-store/orders/pdf-ownership?product_ids=${encodeURIComponent(ids.join(','))}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal,
    }
  )
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok !== true || !Array.isArray(data.products)) {
    throw new Error(data.message || 'PDF ownership could not be verified.')
  }
  return { authenticated: true, products: data.products }
}

export async function recheckAuthorStorePdfPayment(orderId, { signal } = {}) {
  const token = readerToken()
  if (!token) throw new Error('Sign in required.')
  const id = String(orderId || '').trim()
  if (!/^A[A-Z0-9]{8,19}$/.test(id)) throw new Error('Invalid PDF order.')

  const response = await fetch(
    `${API_URL}/api/author-store/orders/${encodeURIComponent(id)}/recheck-pdf-payment`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal,
    }
  )
  const data = await response.json().catch(() => ({}))
  if (!response.ok && response.status !== 202) {
    throw new Error(data.message || 'Payment verification is temporarily unavailable.')
  }
  return data
}
