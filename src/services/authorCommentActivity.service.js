import { supabase } from '../config/supabase.js'

function cleanText(value) {
  return String(value || '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
}

function cleanMetadata(value) {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value
  }

  return {}
}

export async function saveAuthorCommentActivityLog({
  authorPageId,
  authorUserId,
  actorType = 'author',
  actorUserId = null,
  actionType,
  targetType,
  targetId = null,
  summary = '',
  metadata = {},
}) {
  const safeAuthorPageId =
    cleanText(authorPageId)
  const safeAuthorUserId =
    cleanText(authorUserId)
  const safeActorType =
    actorType === 'system'
      ? 'system'
      : 'author'
  const safeActorUserId =
    safeActorType === 'system'
      ? null
      : cleanText(
          actorUserId ||
          authorUserId
        ) || null
  const safeActionType =
    cleanText(actionType)
  const safeTargetType =
    cleanText(targetType)

  if (
    !safeAuthorPageId ||
    !safeAuthorUserId ||
    !safeActionType ||
    !safeTargetType
  ) {
    return null
  }

  const { data, error } = await supabase
    .from(
      'author_comment_activity_logs'
    )
    .insert({
      author_page_id:
        safeAuthorPageId,
      author_user_id:
        safeAuthorUserId,
      actor_type:
        safeActorType,
      actor_user_id:
        safeActorUserId,
      action_type:
        safeActionType,
      target_type:
        safeTargetType,
      target_id:
        cleanText(targetId) || null,
      summary:
        cleanText(summary),
      metadata:
        cleanMetadata(metadata),
    })
    .select('*')
    .single()

  if (error) throw error

  return data
}

export async function saveAuthorCommentActivityLogSafely(
  options
) {
  try {
    return await saveAuthorCommentActivityLog(
      options
    )
  } catch (error) {
    console.warn(
      'AUTHOR COMMENT ACTIVITY LOG WARNING:',
      error.message
    )

    return null
  }
}
