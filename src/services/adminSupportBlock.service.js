const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function validSupportConversationId(value) {
  return typeof value === 'string' && UUID.test(value)
}

export function parseSupportBlockInput(admin, conversationId, body) {
  if (admin?.role !== 'owner' || typeof admin.admin_id !== 'string' || !admin.admin_id.trim() || admin.admin_id.length > 128) return null
  if (!validSupportConversationId(conversationId) || !body || typeof body !== 'object' || Array.isArray(body) || typeof body.blocked !== 'boolean') return null
  return { p_conversation_id: conversationId, p_admin_id: admin.admin_id, p_blocked: body.blocked }
}

export function supportBlockError(error) {
  const message = String(error?.message || '').toLowerCase()
  if (message.includes('owner required')) return { status: 403, code: 'SUPPORT_BLOCK_OWNER_REQUIRED', message: 'Only the Owner can block support messaging' }
  if (message.includes('not found')) return { status: 404, code: 'SUPPORT_BLOCK_NOT_FOUND', message: 'Support conversation not found' }
  if (message.includes('invalid')) return { status: 400, code: 'SUPPORT_BLOCK_INVALID', message: 'Invalid support block request' }
  return { status: 503, code: 'SUPPORT_BLOCK_UNAVAILABLE', message: 'Support block is temporarily unavailable' }
}

export async function getAdminSupportBlock(db, admin, conversationId) {
  if (!validSupportConversationId(conversationId) || !admin?.admin_id || !['owner', 'admin', 'staff'].includes(admin.role)) throw new Error('Invalid support block input')
  let query = db.from('admin_support_conversations').select('id, support_blocked_at').eq('id', conversationId)
  if (admin.role === 'staff') query = query.eq('assigned_admin_id', String(admin.admin_id))
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Support conversation not found')
  return { ok: true, conversation_id: data.id, blocked: data.support_blocked_at != null }
}

export async function getReaderSupportBlock(db, readerId) {
  if (!validSupportConversationId(readerId)) throw new Error('Invalid support block input')
  const { data, error } = await db.from('admin_support_conversations').select('support_blocked_at').eq('reader_user_id', readerId).maybeSingle()
  if (error) throw error
  return { ok: true, blocked: data?.support_blocked_at != null }
}

export async function setAdminSupportBlock(db, input) {
  const { data, error } = await db.rpc('admin_support_set_block_v1', input)
  if (error) throw error
  if (data?.ok !== true || typeof data.blocked !== 'boolean') throw new Error('Unexpected block response')
  return data
}
