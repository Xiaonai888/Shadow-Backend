import { supabase } from '../config/supabase.js'
import { getReaderTagMentionPermissions } from './readerTagMentionPermissions.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i
const LIMIT = 20

function mentionsInText(content) {
  const names = new Set()
  const pattern = /(^|[^A-Za-z0-9_@./])@([A-Za-z0-9_]{3,30})(?![A-Za-z0-9_])/g
  for (const match of String(content || '').matchAll(pattern)) {
    names.add(match[2].toLowerCase())
    if (names.size >= LIMIT) break
  }
  return [...names]
}

async function mentionIds(content, actorId) {
  const names = mentionsInText(content)
  if (!names.length) return []
  const filters = names.map((name) => `username.ilike.${name.replace(/_/g, '\\_')}`).join(',')
  const { data, error } = await supabase
    .from('users')
    .select('id,username')
    .eq('is_active', true)
    .or(filters)
    .limit(LIMIT)
  if (error) throw error
  const wanted = new Set(names)
  return [...new Set((data || [])
    .filter((row) => wanted.has(String(row.username || '').toLowerCase()))
    .map((row) => String(row.id || '').toLowerCase())
    .filter((id) => UUID.test(id) && id !== actorId))]
}

function tagIds(value, actorId) {
  if (!Array.isArray(value) || value.length > LIMIT) throw new TypeError('Invalid tagged users')
  return [...new Set(value.map((id) => String(id || '').trim().toLowerCase()))]
    .filter((id) => UUID.test(id) && id !== actorId)
}

async function permittedRows({ actorId, postId, commentId, kind, targetIds }) {
  if (!targetIds.length) return []
  const checks = await getReaderTagMentionPermissions({
    actorUserId: actorId,
    targetUserIds: targetIds,
    type: kind,
  })
  return targetIds.flatMap((id) => {
    const permission = checks.get(id)
    if (!permission?.allowed) return []
    return [{
      ...(postId ? { post_id: postId } : { comment_id: commentId }),
      actor_user_id: actorId,
      target_user_id: id,
      kind,
      status: permission.requiresReview ? 'pending' : 'approved',
    }]
  })
}

export async function syncReaderPostTagMentionLinks({
  postId,
  actorUserId,
  content,
  taggedUserIds,
  updateMentions = true,
  updateTags = false,
  existingPost = false,
}) {
  const actorId = String(actorUserId || '').trim().toLowerCase()
  if (!UUID.test(actorId) || !UUID.test(String(postId || ''))) {
    throw new TypeError('Invalid post or author ID')
  }
  if (!updateMentions && !updateTags) return
  const [mentions, tags] = await Promise.all([
    updateMentions ? mentionIds(content, actorId) : Promise.resolve([]),
    updateTags ? Promise.resolve(tagIds(taggedUserIds, actorId)) : Promise.resolve([]),
  ])
  if (!existingPost && !mentions.length && !tags.length) return
  const [mentionRows, tagRows] = await Promise.all([
    updateMentions ? permittedRows({ actorId, postId, kind: 'mention', targetIds: mentions }) : Promise.resolve([]),
    updateTags ? permittedRows({ actorId, postId, kind: 'tag', targetIds: tags }) : Promise.resolve([]),
  ])
  const requested = [...mentionRows, ...tagRows]
  let previous = []
  if (existingPost) {
    const { data, error } = await supabase
      .from('reader_tag_mention_links')
      .select('id,kind,target_user_id')
      .eq('post_id', postId)
      .eq('actor_user_id', actorId)
    if (error) throw error
    previous = data || []
  }
  const key = (row) => `${row.kind}:${String(row.target_user_id).toLowerCase()}`
  const nextKeys = new Set(requested.map(key))
  const pastKeys = new Set(previous.map(key))
  const removeIds = previous
    .filter((row) => (row.kind === 'mention' ? updateMentions : updateTags) && !nextKeys.has(key(row)))
    .map((row) => row.id)
  const addRows = requested.filter((row) => !pastKeys.has(key(row)))
  if (removeIds.length) {
    const { error } = await supabase
      .from('reader_tag_mention_links')
      .delete()
      .eq('post_id', postId)
      .eq('actor_user_id', actorId)
      .in('id', removeIds)
    if (error) throw error
  }
  if (addRows.length) {
    const { error } = await supabase.from('reader_tag_mention_links').insert(addRows)
    if (error && error.code !== '23505') throw error
  }
}

export async function syncReaderCommentMentionLinks({
  commentId,
  actorUserId,
  text,
  existingComment = false,
  moderationPending = false,
}) {
  const actorId = String(actorUserId || '').trim().toLowerCase()
  const id = String(commentId || '').trim().toLowerCase()
  if (!UUID.test(actorId) || !UUID.test(id)) {
    throw new TypeError('Invalid comment or author ID')
  }
  const mentions = await mentionIds(text, actorId)
  if (!existingComment && !mentions.length) return
  const requested = await permittedRows({
    actorId,
    commentId: id,
    kind: 'mention',
    targetIds: mentions,
  })
  const desiredStatus = moderationPending ? 'pending' : 'approved'
  let previous = []
  if (existingComment) {
    const { data, error } = await supabase
      .from('reader_tag_mention_links')
      .select('id,target_user_id,status')
      .eq('comment_id', id)
      .eq('actor_user_id', actorId)
      .eq('kind', 'mention')
    if (error) throw error
    previous = data || []
  }
  const desiredIds = new Set(requested.map((row) => row.target_user_id))
  const previousIds = new Set(previous.map((row) => String(row.target_user_id).toLowerCase()))
  const removeIds = previous
    .filter((row) => !desiredIds.has(String(row.target_user_id).toLowerCase()))
    .map((row) => row.id)
  const insertRows = requested
    .filter((row) => !previousIds.has(row.target_user_id))
    .map((row) => ({ ...row, status: desiredStatus }))
  const statusIds = previous
    .filter((row) => desiredIds.has(String(row.target_user_id).toLowerCase()) && row.status !== desiredStatus)
    .map((row) => row.id)
  if (removeIds.length) {
    const { error } = await supabase
      .from('reader_tag_mention_links')
      .delete()
      .eq('comment_id', id)
      .eq('actor_user_id', actorId)
      .in('id', removeIds)
    if (error) throw error
  }
  if (statusIds.length) {
    const { error } = await supabase
      .from('reader_tag_mention_links')
      .update({ status: desiredStatus, reviewed_at: null })
      .eq('comment_id', id)
      .eq('actor_user_id', actorId)
      .in('id', statusIds)
    if (error) throw error
  }
  if (insertRows.length) {
    const { error } = await supabase
      .from('reader_tag_mention_links')
      .insert(insertRows)
    if (error && error.code !== '23505') throw error
  }
}
