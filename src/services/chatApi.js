const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  (window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1'
    ? 'http://localhost:5000'
    : 'https://shadow-backend-kucw.onrender.com')

export class ChatApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ChatApiError'
    this.status = status
    this.code = code
  }
}

export function getReaderToken() {
  return (
    sessionStorage.getItem('shadow_reader_token') ||
    localStorage.getItem('shadow_reader_token') ||
    ''
  )
}

export function hasReaderSession() {
  return Boolean(getReaderToken())
}

async function chatRequest(path, options = {}) {
  const token = getReaderToken()

  if (!token) {
    throw new ChatApiError(
      401,
      'LOGIN_REQUIRED',
      'Please log in to use messages'
    )
  }

  const response = await fetch(`${API_BASE_URL}/api/chat${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body
        ? { 'Content-Type': 'application/json' }
        : {}),
    },
    ...(options.body
      ? { body: JSON.stringify(options.body) }
      : {}),
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok || data.ok === false) {
    throw new ChatApiError(
      response.status,
      data.code || 'CHAT_REQUEST_FAILED',
      data.message || 'Chat request failed'
    )
  }

  return data
}

export function getChatConversations(status = 'all') {
  const query = new URLSearchParams()

  if (status && status !== 'all') {
    query.set('status', status)
  }

  const suffix = query.toString()
    ? `?${query.toString()}`
    : ''

  return chatRequest(`/conversations${suffix}`)
}

export function getChatMessages(
  conversationId,
  { before = '', limit = 50 } = {}
) {
  const query = new URLSearchParams()

  query.set('limit', String(limit))

  if (before) {
    query.set('before', before)
  }

  return chatRequest(
    `/conversations/${encodeURIComponent(
      conversationId
    )}/messages?${query.toString()}`
  )
}

export function createReaderAuthorMessageRequest({
  authorPageId,
  message,
}) {
  return chatRequest('/reader-author/requests', {
    method: 'POST',
    body: {
      author_page_id: authorPageId,
      message,
    },
  })
}

export function sendChatMessage(
  conversationId,
  message
) {
  return chatRequest(
    `/conversations/${encodeURIComponent(
      conversationId
    )}/messages`,
    {
      method: 'POST',
      body: { message },
    }
  )
}

export function decideChatRequest(
  conversationId,
  action
) {
  return chatRequest(
    `/conversations/${encodeURIComponent(
      conversationId
    )}/request`,
    {
      method: 'PATCH',
      body: { action },
    }
  )
}

export function markChatRead(conversationId) {
  return chatRequest(
    `/conversations/${encodeURIComponent(
      conversationId
    )}/read`,
    {
      method: 'PATCH',
    }
  )
}
