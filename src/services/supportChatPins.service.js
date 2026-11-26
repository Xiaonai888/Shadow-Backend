const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseSupportPinInput(kind, actorId, conversationId, action, messageId) {
  if (!['reader', 'admin'].includes(kind) || typeof actorId !== 'string' || !actorId.trim() || actorId.length > 128) return null
  if (!['list', 'pin', 'unpin'].includes(action)) return null
  if (kind === 'reader' && !UUID.test(actorId)) return null
  if (kind === 'admin' && (typeof conversationId !== 'string' || !UUID.test(conversationId))) return null
  if (action !== 'list' && (typeof messageId !== 'string' || !UUID.test(messageId))) return null
  return { p_actor_kind: kind, p_actor_id: actorId, p_conversation_id: kind === 'admin' ? conversationId : null, p_action: action, p_message_id: action === 'list' ? null : messageId }
}

export function supportPinError(error) {
  const code = String(error?.message || '')
  const statuses = { SUPPORT_PIN_INVALID: 400, SUPPORT_PIN_NOT_FOUND: 404, SUPPORT_PIN_ARCHIVED: 409, SUPPORT_PIN_LIMIT: 409, SUPPORT_CHAT_BLOCKED: 403 }
  if (Object.hasOwn(statuses, code)) return { status: statuses[code], code }
  return { status: 503, code: 'SUPPORT_PIN_UNAVAILABLE' }
}

export async function runSupportPin(db, input) {
  const { data, error } = await db.rpc('admin_support_pins_v1', input)
  if (error) throw error
  if (data?.ok !== true || !Array.isArray(data.pins) || data.pins.length > 50) throw new Error('Invalid support pin response')
  return data
}
