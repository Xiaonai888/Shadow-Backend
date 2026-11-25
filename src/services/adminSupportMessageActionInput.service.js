import { randomUUID } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isSupportMessageId(value) {
  return typeof value === 'string' && UUID.test(value)
}

export function parseSupportMessageAction(params, body, action) {
  const conversationId = params?.conversationId
  const messageId = params?.messageId
  if (!isSupportMessageId(conversationId) || !isSupportMessageId(messageId)) return null
  if (!['edit', 'delete', 'reply'].includes(action)) return null
  if (action === 'delete') return { conversationId, messageId, action }
  const text = typeof body?.message === 'string' ? body.message.trim() : ''
  if (!text || text.length > 2000) return null
  if (action === 'edit') return { conversationId, messageId, action, text }
  const requestId = body?.request_id === undefined ? randomUUID() : body.request_id
  if (!isSupportMessageId(requestId) || requestId.toLowerCase() === messageId.toLowerCase()) return null
  return { conversationId, messageId, action, text, requestId }
}

export function supportMessageActionError(error) {
  const detail = String(error?.message || '').toLowerCase()
  if (detail.includes('not found') || detail.includes('not assigned')) return { status: 404, code: 'ADMIN_SUPPORT_MESSAGE_NOT_FOUND', message: 'Support message not found' }
  if (detail.includes('archived') || detail.includes('deleted') || detail.includes('already')) return { status: 409, code: 'ADMIN_SUPPORT_MESSAGE_CONFLICT', message: 'Message or conversation has changed' }
  if (detail.includes('invalid')) return { status: 400, code: 'ADMIN_SUPPORT_MESSAGE_INVALID', message: 'Invalid message action' }
  return { status: 503, code: 'ADMIN_SUPPORT_MESSAGE_UNAVAILABLE', message: 'Support message action is unavailable' }
}
