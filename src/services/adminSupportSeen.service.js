const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(value) {
  return typeof value === 'string' && UUID.test(value)
}

export function parseSupportSeenInput(kind, actorId, conversationId, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !isUuid(body.through_message_id)) return null
  if (kind === 'reader') {
    if (!isUuid(actorId)) return null
    return { p_actor_kind: kind, p_actor_id: actorId, p_conversation_id: null, p_through_message_id: body.through_message_id }
  }
  if (kind !== 'admin' || typeof actorId !== 'string' || !actorId.trim() || actorId.length > 128 || !isUuid(conversationId)) return null
  return { p_actor_kind: kind, p_actor_id: actorId, p_conversation_id: conversationId, p_through_message_id: body.through_message_id }
}

export async function markSupportSeen(db, input, publish) {
  const { data, error } = await db.rpc('admin_support_mark_seen_v1', input)
  if (error) throw error
  if (data?.ok !== true) throw new Error('Invalid seen response')
  if (Number(data.changed_count) > 0 || data.unread_changed === true) {
    try { publish({ assignedAdminId: data.assigned_admin_id || null }) } catch {}
  }
  const { assigned_admin_id, ...safe } = data
  return safe
}

export function supportSeenError(error) {
  const message = String(error?.message || '').toLowerCase()
  if (message.includes('not found')) return { status: 404, code: 'SUPPORT_SEEN_NOT_FOUND', message: 'Support message or conversation not found' }
  if (message.includes('invalid')) return { status: 400, code: 'SUPPORT_SEEN_INVALID', message: 'Invalid seen request' }
  return { status: 503, code: 'SUPPORT_SEEN_UNAVAILABLE', message: 'Seen status is temporarily unavailable' }
}
