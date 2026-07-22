import { supabase } from '../config/supabase.js'

const DELETE_ERROR_MESSAGES = {
  INVALID_DELETE_REQUEST: 'Invalid comment delete request',
  INVALID_DELETE_ROLE: 'Invalid comment delete role',
  COMMENT_NOT_FOUND: 'Comment not found',
  COMMENT_ALREADY_DELETED: 'Comment is already in trash',
  STORY_NOT_FOUND: 'Story not found',
  AUTHOR_PAGE_NOT_FOUND: 'Author Page not found',
  DELETE_NOT_ALLOWED: 'You cannot delete this comment',
  COMMENT_DELETE_LIMIT_REACHED: 'Comment delete limit reached. Please try again later.',
}

const RECOVERY_ERROR_MESSAGES = {
  INVALID_RECOVERY_REQUEST: 'Invalid comment recovery request',
  COMMENT_NOT_FOUND: 'Comment not found',
  COMMENT_NOT_DELETED: 'Comment is not in trash',
  COMMENT_RECOVERY_EXPIRED: 'Comment recovery period has expired',
  RECOVERY_NOT_ALLOWED: 'You cannot recover this comment',
}

function normalizeResult(data) {
  if (Array.isArray(data)) return data[0] || {}
  return data && typeof data === 'object' ? data : {}
}

async function runTrashRpc(functionName, params) {
  const { data, error } = await supabase.rpc(functionName, params)

  if (error) {
    throw new Error(error.message || 'Comment trash operation failed')
  }

  return normalizeResult(data)
}

export function getCommentTrashStatus(result) {
  const code = String(result?.code || '')

  if (code === 'COMMENT_NOT_FOUND' || code === 'STORY_NOT_FOUND' || code === 'AUTHOR_PAGE_NOT_FOUND') {
    return 404
  }

  if (code === 'COMMENT_RECOVERY_EXPIRED') return 410
  if (code === 'COMMENT_DELETE_LIMIT_REACHED') return 429
  if (code === 'DELETE_NOT_ALLOWED' || code === 'RECOVERY_NOT_ALLOWED') return 403
  if (code === 'COMMENT_ALREADY_DELETED' || code === 'COMMENT_NOT_DELETED') return 409
  return 400
}

export function getCommentTrashMessage(result, operation = 'delete') {
  const code = String(result?.code || '')
  const messages = operation === 'recover' ? RECOVERY_ERROR_MESSAGES : DELETE_ERROR_MESSAGES
  return messages[code] || `Failed to ${operation} comment`
}

export async function deleteStoryCommentToTrash({
  commentId,
  actorType,
  actorId,
  reason = '',
}) {
  return runTrashRpc('soft_delete_story_comment', {
    p_comment_id: commentId,
    p_actor_type: actorType,
    p_actor_id: actorId,
    p_reason: reason,
  })
}

export async function recoverStoryCommentFromTrash({
  commentId,
  actorType,
  actorId,
}) {
  return runTrashRpc('recover_story_comment', {
    p_comment_id: commentId,
    p_actor_type: actorType,
    p_actor_id: actorId,
  })
}

export async function deleteAuthorPageCommentToTrash({
  commentId,
  actorType,
  actorId,
  reason = '',
}) {
  return runTrashRpc('soft_delete_author_page_comment', {
    p_comment_id: commentId,
    p_actor_type: actorType,
    p_actor_id: actorId,
    p_reason: reason,
  })
}

export async function recoverAuthorPageCommentFromTrash({
  commentId,
  actorType,
  actorId,
}) {
  return runTrashRpc('recover_author_page_comment', {
    p_comment_id: commentId,
    p_actor_type: actorType,
    p_actor_id: actorId,
  })
}
