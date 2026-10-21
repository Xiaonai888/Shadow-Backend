import { getReaderToken } from './chatApi'

const API_BASE_URL = import.meta.env.VITE_API_URL ||
  ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:5000'
    : 'https://shadow-backend-kucw.onrender.com')

export class ReaderBlockApiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ReaderBlockApiError'
    this.status = status
  }
}

async function requestBlockApi(path, { method = 'GET', signal } = {}) {
  const token = getReaderToken()
  if (!token) throw new ReaderBlockApiError(401, 'Please log in to continue')

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    signal,
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) {
    throw new ReaderBlockApiError(response.status, data.message || 'Unable to complete this request')
  }
  return data
}

function requireTargetType(type) {
  if (type !== 'reader' && type !== 'page') {
    throw new ReaderBlockApiError(400, 'Invalid account type')
  }
  return type
}

export function searchReaderBlockTargets({ type, query, signal }) {
  const params = new URLSearchParams({ type: requireTargetType(type), q: String(query || '').trim() })
  return requestBlockApi(`/api/users/me/block-targets/search?${params}`, { signal })
}

export function getReaderBlockedAccounts({ type, offset = 0, limit = 10, signal }) {
  const params = new URLSearchParams({
    type: requireTargetType(type),
    offset: String(Math.max(0, Number(offset) || 0)),
    limit: String(Math.min(10, Math.max(1, Number(limit) || 10))),
  })
  return requestBlockApi(`/api/users/me/blocked?${params}`, { signal })
}

export function changeReaderBlockedAccount({ type, target, shouldBlock }) {
  const safeType = requireTargetType(type)
  const method = shouldBlock ? 'POST' : 'DELETE'
  if (safeType === 'reader') {
    const readerId = String(target?.id || target?.user_id || '').trim()
    if (!readerId) throw new ReaderBlockApiError(400, 'Reader ID is missing')
    return requestBlockApi(`/api/users/me/blocked/readers/${encodeURIComponent(readerId)}`, { method })
  }

  const pageUsername = String(target?.page_username || target?.username || '').trim()
  if (!pageUsername) throw new ReaderBlockApiError(400, 'Page username is missing')
  return requestBlockApi(`/api/authors/page/${encodeURIComponent(pageUsername)}/block`, { method })
}
