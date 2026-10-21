import { supabase } from '../config/supabase.js'

export const DEFAULT_READER_COMMENT_SETTINGS = Object.freeze({
  audience: 'everyone',
  allowComments: true,
  filterSpam: true,
  commentApproval: false,
})

export const READER_COMMENT_AUDIENCES = new Set(['everyone', 'followers', 'following'])

const SETTINGS_COLUMNS = 'audience,allow_comments,filter_spam,comment_approval'

export function normalizeReaderCommentSettings(row) {
  return {
    audience: READER_COMMENT_AUDIENCES.has(row?.audience)
      ? row.audience
      : DEFAULT_READER_COMMENT_SETTINGS.audience,
    allowComments: typeof row?.allow_comments === 'boolean'
      ? row.allow_comments
      : DEFAULT_READER_COMMENT_SETTINGS.allowComments,
    filterSpam: typeof row?.filter_spam === 'boolean'
      ? row.filter_spam
      : DEFAULT_READER_COMMENT_SETTINGS.filterSpam,
    commentApproval: typeof row?.comment_approval === 'boolean'
      ? row.comment_approval
      : DEFAULT_READER_COMMENT_SETTINGS.commentApproval,
  }
}

export async function getReaderCommentSettings(userId) {
  if (!userId) throw new Error('Reader account is required')
  const { data, error } = await supabase
    .from('reader_comment_settings')
    .select(SETTINGS_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return normalizeReaderCommentSettings(data)
}

export async function saveReaderCommentSettings(userId, settings) {
  if (!userId) throw new Error('Reader account is required')
  const { data, error } = await supabase
    .from('reader_comment_settings')
    .upsert({
      user_id: userId,
      audience: settings.audience,
      allow_comments: settings.allowComments,
      filter_spam: settings.filterSpam,
      comment_approval: settings.commentApproval,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
    .select(SETTINGS_COLUMNS)
    .single()
  if (error) throw error
  return normalizeReaderCommentSettings(data)
}
