import { publishAdminSupportNotificationChanged } from './adminSupportNotificationSse.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NOTIFICATION_ACTIONS = new Set(['read', 'archive', 'restore', 'assign'])

function publishSafely(publish, scope) {
  try {
    return publish(scope)
  } catch {
    return 0
  }
}

export async function notifyReaderSupportMessage(db, result, readerUserId, { publish = publishAdminSupportNotificationChanged } = {}) {
  if (result?.ok !== true || result.created !== true || !UUID.test(String(result.conversation_id || '')) || !UUID.test(String(readerUserId || ''))) return 0
  let assignedAdminId = null
  try {
    const scope = await db.from('admin_support_conversations')
      .select('assigned_admin_id')
      .eq('id', result.conversation_id)
      .eq('reader_user_id', readerUserId)
      .abortSignal(AbortSignal.timeout(2000))
      .maybeSingle()
    if (!scope.error) assignedAdminId = scope.data?.assigned_admin_id || null
  } catch {}
  return publishSafely(publish, { assignedAdminId })
}

export function notifyAdminSupportConversationAction(result, conversation, { action, value } = {}, { publish = publishAdminSupportNotificationChanged } = {}) {
  if (result?.ok !== true || !conversation?.id || result.conversation_id !== conversation.id || result.action !== action || !NOTIFICATION_ACTIONS.has(action)) return 0
  const previousAssignedAdminId = conversation.assigned_admin_id || null
  const assignedAdminId = action === 'assign' ? String(value ?? '').trim() || null : previousAssignedAdminId
  return publishSafely(publish, { assignedAdminId, previousAssignedAdminId })
}
