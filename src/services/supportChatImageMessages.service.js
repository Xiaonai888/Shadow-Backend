import { createHash } from 'node:crypto'
import { isSupportImageId, supportImageError, issueSupportImageToken, verifySupportImageToken, parseSupportImageCaption } from './supportChatImageToken.service.js'
import { validateSupportImageKey } from './supportChatImageInput.service.js'

const notFound = () => supportImageError(404, 'SUPPORT_IMAGE_NOT_FOUND')

async function getConversation(db, actor, conversationId, write = false) {
  let query = db.from('admin_support_conversations').select('id, reader_user_id, status, support_blocked_at, assigned_admin_id')
  if (actor.kind === 'reader') query = query.eq('reader_user_id', actor.id)
  else {
    if (!isSupportImageId(conversationId)) throw notFound()
    query = query.eq('id', conversationId)
    if (actor.role === 'staff') query = query.eq('assigned_admin_id', actor.id)
  }
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  if (!data && actor.kind === 'admin') throw notFound()
  if (write && data?.status === 'archived') throw supportImageError(409, 'SUPPORT_IMAGE_ARCHIVED')
  if (write && actor.kind === 'reader' && data?.support_blocked_at) throw supportImageError(403, 'SUPPORT_CHAT_BLOCKED')
  return data
}

export async function initSupportImage(db, r2, actor, conversationId, body) {
  await getConversation(db, actor, conversationId, true)
  const upload = r2.createPrivateSupportImageUpload(body)
  const signed = issueSupportImageToken(actor, conversationId, upload)
  return { ok: true, upload_url: upload.upload_url, upload_token: signed.token, request_id: signed.messageId, expires_in_seconds: upload.expires_in_seconds }
}

function safeMessage(row) {
  return { id: row.id, conversation_id: row.conversation_id, sender_kind: row.sender_kind, public_support_id: row.public_support_id, message_text: row.deleted_at ? null : row.message_text, attachments: row.deleted_at ? [] : row.attachments, seen_at: row.seen_at, created_at: row.created_at, edited_at: row.edited_at, deleted_at: row.deleted_at, reply_to_message_id: row.reply_to_message_id }
}

function publicAdminId(id) {
  return `S-${createHash('sha256').update(id).digest('hex').slice(0, 8).toUpperCase()}`
}

async function findExisting(db, actor, chat, claims, caption) {
  if (!chat) return null
  const { data, error } = await db.from('admin_support_messages').select('id, conversation_id, sender_kind, sender_admin_id, public_support_id, message_text, attachments, seen_at, created_at, edited_at, deleted_at, reply_to_message_id').eq('id', claims.messageId).eq('conversation_id', chat.id).maybeSingle()
  if (error) throw error
  if (!data) return null
  const attachment = Array.isArray(data.attachments) && data.attachments.length === 1 ? data.attachments[0] : null
  if (data.sender_kind !== actor.kind || (actor.kind === 'admin' && data.sender_admin_id !== actor.id) || !attachment || attachment.type !== 'image' || attachment.mime_type !== claims.mime || attachment.file_size !== claims.size || !validateSupportImageKey(attachment.storage_key, 'media', claims.mime)) throw supportImageError(409, 'SUPPORT_IMAGE_REQUEST_CONFLICT')
  if (!data.edited_at && data.message_text !== caption) throw supportImageError(409, 'SUPPORT_IMAGE_REQUEST_CONFLICT')
  return { ok: true, created: false, conversation_id: chat.id, message: safeMessage(data) }
}

export async function finalizeSupportImage(db, r2, actor, conversationId, body) {
  const claims = verifySupportImageToken(body?.upload_token, actor, conversationId)
  const caption = parseSupportImageCaption(body?.message)
  const chat = await getConversation(db, actor, conversationId)
  const existing = await findExisting(db, actor, chat, claims, caption)
  if (existing) return existing
  if (chat?.status === 'archived') throw supportImageError(409, 'SUPPORT_IMAGE_ARCHIVED')
  if (actor.kind === 'reader' && chat?.support_blocked_at) throw supportImageError(403, 'SUPPORT_CHAT_BLOCKED')
  const attachment = await r2.promotePrivateSupportImage(claims)
  const { data, error } = await db.rpc('admin_support_send_image_v1', {
    p_actor_kind: actor.kind, p_actor_id: actor.id, p_conversation_id: conversationId,
    p_public_support_id: actor.kind === 'admin' ? publicAdminId(actor.id) : null,
    p_message_id: claims.messageId, p_message_text: caption, p_attachment: attachment,
  })
  if (error) throw error
  if (data?.ok !== true || !isSupportImageId(data.conversation_id) || typeof data.created !== 'boolean') throw new Error('Invalid support image RPC result')
  if (data.created === false && data.message?.attachments?.[0]?.storage_key !== attachment.storage_key) {
    await r2.deletePrivateSupportImage(attachment.storage_key, 'media').catch(() => {})
  }
  await r2.deletePrivateSupportImage(claims.key, 'temp').catch(() => {})
  return data
}

export async function getSupportImageView(db, r2, actor, conversationId, messageId) {
  if (!isSupportImageId(messageId)) throw notFound()
  const chat = await getConversation(db, actor, conversationId)
  if (!chat) throw notFound()
  const { data, error } = await db.from('admin_support_messages').select('id, attachments').eq('id', messageId).eq('conversation_id', chat.id).is('deleted_at', null).maybeSingle()
  if (error) throw error
  const image = Array.isArray(data?.attachments) && data.attachments.find(item => item?.type === 'image' && validateSupportImageKey(item.storage_key, 'media', item.mime_type))
  if (!image) throw notFound()
  return { ok: true, ...r2.getPrivateSupportImageReadUrl(image.storage_key) }
}
