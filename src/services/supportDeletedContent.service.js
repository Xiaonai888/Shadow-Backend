import { validateSupportImageKey } from './supportChatImageInput.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RETENTION_MS = 30 * 86400000
const IMAGE_WINDOW_MS = 125000

function failure(statusCode, code) {
  return Object.assign(new Error(code), { statusCode, code })
}

export async function getDeletedSupportContent({ db, signImage, admin, conversationId, messageId, now = Date.now }) {
  if (!['owner', 'admin'].includes(admin?.role) || !admin.admin_id || !(admin.has_all_permissions || admin.permission_keys?.includes('admin_chat.view'))) throw failure(403, 'SUPPORT_DELETED_FORBIDDEN')
  if (!UUID.test(String(conversationId || '')) || !UUID.test(String(messageId || ''))) throw failure(400, 'SUPPORT_DELETED_INVALID_ID')
  const notFound = () => failure(404, 'SUPPORT_DELETED_NOT_FOUND')
  const { data: row, error } = await db.from('admin_support_deleted_reader_content')
    .select('message_id, conversation_id, deleted_at, expires_at, message_text, attachments')
    .eq('conversation_id', conversationId).eq('message_id', messageId)
    .gt('expires_at', new Date(now()).toISOString()).maybeSingle()
  if (error) throw error
  if (!row || row.message_id !== messageId || row.conversation_id !== conversationId) throw notFound()
  const expires = Date.parse(row.expires_at)
  const deleted = Date.parse(row.deleted_at)
  if (!Number.isFinite(expires) || !Number.isFinite(deleted) || expires !== deleted + RETENTION_MS || expires <= now()) throw notFound()
  const image = Array.isArray(row.attachments) && row.attachments.find(item => item?.type === 'image' && typeof item.mime_type === 'string' && validateSupportImageKey(item.storage_key, 'media', item.mime_type))
  const { error: logError } = await db.from('admin_support_activity').insert({
    conversation_id: conversationId, conversation_ref: conversationId, admin_id: String(admin.admin_id),
    action: 'deleted_message_reveal', details: { message_id: messageId },
  })
  if (logError) throw logError
  if (expires <= now()) throw notFound()
  const signed = image && expires - now() > IMAGE_WINDOW_MS ? signImage(image.storage_key) : null
  return {
    ok: true, message_id: messageId, deleted_at: row.deleted_at, expires_at: row.expires_at,
    message_text: typeof row.message_text === 'string' ? row.message_text : null,
    has_image: Boolean(image), image: signed ? { url: signed.url, expires_in_seconds: signed.expires_in_seconds } : null,
  }
}
