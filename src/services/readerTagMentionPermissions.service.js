import { supabase } from '../config/supabase.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TYPES = new Set(['tag', 'mention'])
const MAX_TARGETS = 20

function normalizeId(value) {
  const id = String(value || '').trim().toLowerCase()
  return UUID_PATTERN.test(id) ? id : ''
}

function deny(reason) {
  return { allowed: false, requiresReview: false, reason }
}

function allow(requiresReview = false) {
  return { allowed: true, requiresReview, reason: null }
}

export async function getReaderTagMentionPermissions({ actorUserId, targetUserIds, type }) {
  if (!TYPES.has(type)) throw new TypeError('Invalid interaction type')

  const actorId = normalizeId(actorUserId)
  if (!actorId) throw new TypeError('Invalid reader ID')
  if (!Array.isArray(targetUserIds)) throw new TypeError('Target IDs must be an array')
  if (targetUserIds.length > MAX_TARGETS) throw new RangeError('Too many targets')

  const ids = [...new Set(targetUserIds.map(normalizeId).filter(Boolean))]
  const results = new Map()
  if (!ids.length) return results

  const otherIds = ids.filter((id) => id !== actorId)
  const usersResult = await supabase
    .from('users')
    .select('id')
    .in('id', ids)
    .eq('is_active', true)
  if (usersResult.error) throw usersResult.error

  const activeIds = new Set((usersResult.data || []).map((row) => String(row.id).toLowerCase()))
  for (const id of ids) {
    if (!activeIds.has(id)) results.set(id, deny('NOT_FOUND'))
    else if (id === actorId) results.set(id, allow())
  }
  if (!otherIds.length) return results

  const validOtherIds = otherIds.filter((id) => activeIds.has(id))
  if (!validOtherIds.length) return results

  const list = validOtherIds.join(',')
  const [settingsResult, blocksResult] = await Promise.all([
    supabase
      .from('reader_tag_mention_settings')
      .select('user_id,tags,mentions,review_tags')
      .in('user_id', validOtherIds),
    supabase
      .from('chat_blocks')
      .select('blocker_user_id,blocked_user_id')
      .or(`and(blocker_user_id.eq.${actorId},blocked_user_id.in.(${list})),and(blocked_user_id.eq.${actorId},blocker_user_id.in.(${list}))`),
  ])
  if (settingsResult.error) throw settingsResult.error
  if (blocksResult.error) throw blocksResult.error

  const settings = new Map((settingsResult.data || []).map((row) => [String(row.user_id).toLowerCase(), row]))
  const blockedIds = new Set((blocksResult.data || []).map((row) => {
    const blocker = String(row.blocker_user_id).toLowerCase()
    return blocker === actorId ? String(row.blocked_user_id).toLowerCase() : blocker
  }))
  const settingKey = type === 'tag' ? 'tags' : 'mentions'
  const followingOnly = validOtherIds.filter((id) => !blockedIds.has(id) && settings.get(id)?.[settingKey] === 'following')
  const followedIds = new Set()

  if (followingOnly.length) {
    const { data, error } = await supabase
      .from('user_follows')
      .select('follower_user_id')
      .in('follower_user_id', followingOnly)
      .eq('following_user_id', actorId)
    if (error) throw error
    for (const row of data || []) followedIds.add(String(row.follower_user_id).toLowerCase())
  }

  for (const id of validOtherIds) {
    if (blockedIds.has(id)) {
      results.set(id, deny('BLOCKED'))
      continue
    }
    const setting = settings.get(id)
    const audience = setting?.[settingKey] || 'everyone'
    if (audience === 'nobody') {
      results.set(id, deny('DISABLED'))
      continue
    }
    if (audience === 'following' && !followedIds.has(id)) {
      results.set(id, deny('NOT_FOLLOWING'))
      continue
    }
    results.set(id, allow(type === 'tag' && setting?.review_tags !== false))
  }

  return results
}

export async function getReaderTagMentionPermission({ actorUserId, targetUserId, type }) {
  const id = normalizeId(targetUserId)
  if (!id) return deny('INVALID_TARGET')
  const results = await getReaderTagMentionPermissions({ actorUserId, targetUserIds: [id], type })
  return results.get(id) || deny('NOT_FOUND')
}
