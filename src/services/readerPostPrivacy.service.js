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

export async function getBlockedReaderOwnerIds(viewerId, ownerIds) {
  const viewer = String(viewerId || '').trim()
  const owners = uniqueIds(ownerIds).filter((id) => id !== viewer)
  if (!viewer || !owners.length) return new Set()

  const [outgoing, incoming] = await Promise.all([
    supabase
      .from('chat_blocks')
      .select('blocked_user_id')
      .eq('blocker_user_id', viewer)
      .in('blocked_user_id', owners),
    supabase
      .from('chat_blocks')
      .select('blocker_user_id')
      .eq('blocked_user_id', viewer)
      .in('blocker_user_id', owners),
  ])

  if (outgoing.error) throw outgoing.error
  if (incoming.error) throw incoming.error

  return new Set([
    ...(outgoing.data || []).map((row) => String(row.blocked_user_id)),
    ...(incoming.data || []).map((row) => String(row.blocker_user_id)),
  ])
}

async function resolveReaderPostReference(sourceId) {
  const raw = String(sourceId || '').trim()
  if (UUID.test(raw)) return { postId: raw, echoOwnerId: '', sourceType: '', sourceId: '' }
  const match = raw.match(/^(echo-v2|social-echo):([0-9a-f-]+)$/i)
  if (!match) return null
  const table = match[1].toLowerCase() === 'echo-v2' ? 'social_echoes_v2' : 'social_echoes'
  const columns = table === 'social_echoes_v2'
    ? 'user_id, source_type, source_id'
    : 'user_id, source_type, source_id, reader_post_id'
  const { data, error } = await supabase.from(table).select(columns).eq('id', match[2]).maybeSingle()
  if (error) throw error
  if (!data) return null
  const sourceType = String(data.source_type || '').trim().toLowerCase().replaceAll('-', '_')
  const sourcePostId = String(data.reader_post_id || data.source_id || '').trim()
  return {
    postId: sourceType === 'reader_post' && UUID.test(sourcePostId) ? sourcePostId : '',
    echoOwnerId: String(data.user_id || ''),
    sourceType,
    sourceId: String(data.source_id || ''),
  }
}

async function resolveReaderPostSourceId(sourceId) {
  return (await resolveReaderPostReference(sourceId))?.postId || null
}

async function getBlockedAuthorEchoSource(viewerId, sourceType, sourceId) {
  if (!viewerId || !sourceId) return false
  let pageId = ''
  if (sourceType === 'author_post') {
    const { data, error } = await supabase
      .from('author_page_posts')
      .select('author_page_id')
      .eq('id', sourceId)
      .maybeSingle()
    if (error) throw error
    pageId = String(data?.author_page_id || '')
  } else if (sourceType === 'story') {
    const { data, error } = await supabase
      .from('stories')
      .select('author_id')
      .eq('id', sourceId)
      .maybeSingle()
    if (error) throw error
    pageId = String(data?.author_id || '')
  } else if (sourceType === 'episode') {
    const episode = await supabase
      .from('episodes')
      .select('story_id')
      .eq('id', sourceId)
      .maybeSingle()
    if (episode.error) throw episode.error
    if (!episode.data?.story_id) return false
    const story = await supabase
      .from('stories')
      .select('author_id')
      .eq('id', episode.data.story_id)
      .maybeSingle()
    if (story.error) throw story.error
    pageId = String(story.data?.author_id || '')
  }
  if (!pageId) return false

  const [pageBlock, pageOwner] = await Promise.all([
    supabase
      .from('reader_blocked_author_pages')
      .select('id')
      .eq('reader_user_id', viewerId)
      .eq('author_page_id', pageId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('author_pages')
      .select('user_id')
      .eq('id', pageId)
      .maybeSingle(),
  ])
  if (pageBlock.error) throw pageBlock.error
  if (pageOwner.error) throw pageOwner.error
  if (pageBlock.data) return true
  const ownerId = String(pageOwner.data?.user_id || '')
  if (!ownerId) return false
  const blockedOwners = await getBlockedReaderOwnerIds(viewerId, [ownerId])
  return blockedOwners.has(ownerId)
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
    const reference = await resolveReaderPostReference(sourceId)
    if (!reference) return next()
    if (reference.echoOwnerId) {
      const blockedEchoOwners = await getBlockedReaderOwnerIds(viewerId, [reference.echoOwnerId])
      if (blockedEchoOwners.has(reference.echoOwnerId)) {
        return res.status(404).json({ ok: false, message: 'Post not found' })
      }
    }
    if (await getBlockedAuthorEchoSource(viewerId, reference.sourceType, reference.sourceId)) {
      return res.status(404).json({ ok: false, message: 'Post not found' })
    }
    const postId = reference.postId
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
    const blockedOwners = await getBlockedReaderOwnerIds(viewerId, [ownerId])
    if (blockedOwners.has(ownerId)) {
      return res.status(404).json({ ok: false, message: 'Post not found' })
    }
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
  const ownerIds = uniqueIds([...postOwners.values()])
  const [privateOwners, blockedOwners] = await Promise.all([
    getPrivateReaderOwnerIds(ownerIds),
    getBlockedReaderOwnerIds(viewerId, ownerIds),
  ])
  const privateOtherOwners = [...privateOwners].filter((id) => id !== String(viewerId || '') && !blockedOwners.has(id))
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
    return Boolean(owner && !blockedOwners.has(owner) && (!privateOwners.has(owner) || owner === String(viewerId) || followed.has(owner)))
  })
}
