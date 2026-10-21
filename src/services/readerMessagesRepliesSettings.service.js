import { supabase } from '../config/supabase.js'

export const DEFAULT_READER_MESSAGES_REPLIES_SETTINGS = Object.freeze({
  messageAudience: 'everyone',
  messageRequests: true,
  replyAudience: 'everyone',
  messageNotifications: true,
})

export const MESSAGE_AUDIENCES = new Set(['everyone', 'following', 'nobody'])
export const REPLY_AUDIENCES = new Set(['everyone', 'followers', 'nobody'])

const SETTINGS_FIELDS = 'message_audience,message_requests,reply_audience,message_notifications'

export function normalizeReaderMessagesRepliesSettings(row) {
  return {
    messageAudience: MESSAGE_AUDIENCES.has(row?.message_audience)
      ? row.message_audience
      : DEFAULT_READER_MESSAGES_REPLIES_SETTINGS.messageAudience,
    messageRequests: typeof row?.message_requests === 'boolean'
      ? row.message_requests
      : DEFAULT_READER_MESSAGES_REPLIES_SETTINGS.messageRequests,
    replyAudience: REPLY_AUDIENCES.has(row?.reply_audience)
      ? row.reply_audience
      : DEFAULT_READER_MESSAGES_REPLIES_SETTINGS.replyAudience,
    messageNotifications: typeof row?.message_notifications === 'boolean'
      ? row.message_notifications
      : DEFAULT_READER_MESSAGES_REPLIES_SETTINGS.messageNotifications,
  }
}

export async function getReaderMessagesRepliesSettings(userId) {
  if (!userId) throw new Error('Reader account is required')
  const { data, error } = await supabase
    .from('reader_messages_replies_settings')
    .select(SETTINGS_FIELDS)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return normalizeReaderMessagesRepliesSettings(data)
}

export async function saveReaderMessagesRepliesSettings(userId, settings) {
  if (!userId) throw new Error('Reader account is required')
  if (
    !settings ||
    !MESSAGE_AUDIENCES.has(settings.messageAudience) ||
    typeof settings.messageRequests !== 'boolean' ||
    !REPLY_AUDIENCES.has(settings.replyAudience) ||
    typeof settings.messageNotifications !== 'boolean'
  ) throw new TypeError('Invalid messages and replies settings')

  const { data, error } = await supabase
    .from('reader_messages_replies_settings')
    .upsert({
      user_id: userId,
      message_audience: settings.messageAudience,
      message_requests: settings.messageRequests,
      reply_audience: settings.replyAudience,
      message_notifications: settings.messageNotifications,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
    .select(SETTINGS_FIELDS)
    .single()
  if (error) throw error
  return normalizeReaderMessagesRepliesSettings(data)
}

export async function canStartReaderMessageRequest(senderUserId, recipientUserId) {
  if (!senderUserId || !recipientUserId) return false
  if (String(senderUserId) === String(recipientUserId)) return false

  const settings = await getReaderMessagesRepliesSettings(recipientUserId)
  if (!settings.messageRequests || settings.messageAudience === 'nobody') return false
  if (settings.messageAudience === 'everyone') return true

  const { data, error } = await supabase
    .from('user_follows')
    .select('follower_user_id')
    .eq('follower_user_id', recipientUserId)
    .eq('following_user_id', senderUserId)
    .maybeSingle()
  if (error) throw error
  return Boolean(data)
}

export async function canReplyToReaderPost(senderUserId, postOwnerId) {
  if (!senderUserId || !postOwnerId) return false
  if (String(senderUserId) === String(postOwnerId)) return true

  const settings = await getReaderMessagesRepliesSettings(postOwnerId)
  if (settings.replyAudience === 'nobody') return false
  if (settings.replyAudience === 'everyone') return true

  const { data, error } = await supabase
    .from('user_follows')
    .select('follower_user_id')
    .eq('follower_user_id', senderUserId)
    .eq('following_user_id', postOwnerId)
    .maybeSingle()
  if (error) throw error
  return Boolean(data)
}
