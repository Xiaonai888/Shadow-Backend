import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function uniqueIds(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))]
}

export async function getPrivateReaderOwnerIds(ownerIds) {
  const ids = uniqueIds(ownerIds)
  if (!ids.length) return new Set()
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .in('id', ids)
    .eq('reader_posts_private', true)
  if (error) throw error
  return new Set((data || []).map((item) => String(item.id)))
}

async function resolveReaderPostSourceId(sourceId) {
  const raw = String(sourceId || '').trim()
  if (UUID.test(raw)) return raw
  const match = raw.match(/^(echo-v2|social-echo):([0-9a-f-]+)$/i)
  if (!match) return null
  const table = match[1].toLowerCase() === 'echo-v2' ? 'social_echoes_v2' : 'social_echoes'
  const columns = table === 'social_echoes_v2' ? 'source_type, source_id' : 'source_type, source_id, reader_post_id'
  const { data, error } = await supabase.from(table).select(columns).eq('id', match[2]).maybeSingle()
  if (error) throw error
  if (!data) return null
  const postId = String(data.reader_post_id || data.source_id || '').trim()
  const sourceType = String(data.source_type || '').trim().toLowerCase().replaceAll('-', '_')
  return sourceType === 'reader_post' && UUID.test(postId) ? postId : null
}

async function getPrivateAccessForOwner(ownerId, viewerId) {
  if (ownerId === viewerId) return true
  const privateOwners = await getPrivateReaderOwnerIds([ownerId])
  if (!privateOwners.has(ownerId)) return true
  if (!viewerId) return false
  const { data, error } = await supabase
    .from('user_follows')
    .select('follower_user_id')
    .eq('follower_user_id', viewerId)
    .eq('following_user_id', ownerId)
    .maybeSingle()
  if (error) throw error
  return Boolean(data)
}

export async function requirePrivateReaderPostAccess(req, res, next) {
  try {
    const viewerId = String(req.user?.user_id || req.user?.id || '').trim()
    let sourceId = req.params.postId
    if (!sourceId && req.params.commentId) {
      const { data, error } = await supabase
        .from('reader_post_comments')
        .select('post_id')
        .eq('id', req.params.commentId)
        .maybeSingle()
      if (error) throw error
      sourceId = data?.post_id
    }
    const postId = await resolveReaderPostSourceId(sourceId)
    if (!postId) return next()
    const { data: post, error } = await supabase
      .from('reader_posts')
      .select('user_id')
      .eq('id', postId)
      .is('deleted_at', null)
      .maybeSingle()
    if (error) throw error
    if (!post) return next()
    const ownerId = String(post.user_id)
    if (await getPrivateAccessForOwner(ownerId, viewerId)) return next()
    return res.status(404).json({ ok: false, message: 'Post not found' })
  } catch (error) {
    console.error('READER POST PRIVACY ACCESS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to check post access' })
  }
}

export async function filterVisibleSavedReaderPosts(items, viewerId) {
  const rows = Array.isArray(items) ? items : []
  const readerRows = rows.filter((row) => row?.source_type === 'reader_post')
  if (!readerRows.length) return rows
  const rawIds = uniqueIds(readerRows.map((row) => row.source_id))
  const mapped = new Map(await Promise.all(rawIds.map(async (id) => [id, await resolveReaderPostSourceId(id)])))
  const postIds = uniqueIds([...mapped.values()])
  if (!postIds.length) return rows.filter((row) => row?.source_type !== 'reader_post')
  const { data: posts, error } = await supabase
    .from('reader_posts')
    .select('id, user_id')
    .in('id', postIds)
    .is('deleted_at', null)
  if (error) throw error
  const postOwners = new Map((posts || []).map((post) => [String(post.id), String(post.user_id)]))
  const privateOwners = await getPrivateReaderOwnerIds([...postOwners.values()])
  const privateOtherOwners = [...privateOwners].filter((id) => id !== String(viewerId || ''))
  let followed = new Set()
  if (privateOtherOwners.length && viewerId) {
    const { data, error: followError } = await supabase
      .from('user_follows')
      .select('following_user_id')
      .eq('follower_user_id', viewerId)
      .in('following_user_id', privateOtherOwners)
    if (followError) throw followError
    followed = new Set((data || []).map((item) => String(item.following_user_id)))
  }
  return rows.filter((row) => {
    if (row?.source_type !== 'reader_post') return true
    const owner = postOwners.get(mapped.get(String(row.source_id)))
    return Boolean(owner && (!privateOwners.has(owner) || owner === String(viewerId) || followed.has(owner)))
  })
}
