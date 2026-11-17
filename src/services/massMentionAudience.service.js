import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_BATCH = 150
const MAX_INPUT = 10000
const MASS_MENTION_PATTERN = /(^|[^A-Za-z0-9_@./])@(followers?|highlight)(?![A-Za-z0-9_])/gi
const SETTINGS_COLUMN = {
  followers: 'followers_mentions',
  highlight: 'highlight_mentions',
}

function validId(value) {
  const id = String(value || '').trim().toLowerCase()
  return UUID.test(id) ? id : ''
}

export function extractMassMentionTags(value) {
  const tags = new Set()
  const text = String(value || '')
  for (const match of text.matchAll(MASS_MENTION_PATTERN)) {
    tags.add(match[2].toLowerCase().startsWith('follower') ? 'followers' : 'highlight')
    if (tags.size === 2) break
  }
  return [...tags]
}

export async function filterMassMentionRecipients({
  senderUserId,
  recipientUserIds,
  tag,
  database = supabase,
}) {
  const senderId = validId(senderUserId)
  if (!senderId) throw new TypeError('Invalid sender ID')
  if (!Object.hasOwn(SETTINGS_COLUMN, tag)) throw new TypeError('Invalid mass mention tag')
  if (!Array.isArray(recipientUserIds)) throw new TypeError('Recipients must be an array')
  if (recipientUserIds.length > MAX_INPUT) throw new RangeError('Too many recipients in one batch')

  const recipients = [...new Set(recipientUserIds.map(validId).filter((id) => id && id !== senderId))]
  const accepted = []

  for (let start = 0; start < recipients.length; start += MAX_BATCH) {
    const group = recipients.slice(start, start + MAX_BATCH)
    const { data: userRows, error: usersError } = await database
      .from('users')
      .select('id')
      .in('id', group)
      .eq('is_active', true)
    if (usersError) throw usersError

    const active = new Set((userRows || []).map((row) => validId(row.id)).filter(Boolean))
    const ids = group.filter((id) => active.has(id))
    if (!ids.length) continue

    const idList = ids.join(',')
    const [settingsResult, blocksResult] = await Promise.all([
      database
        .from('reader_tag_mention_settings')
        .select(`user_id,${SETTINGS_COLUMN[tag]}`)
        .in('user_id', ids),
      database
        .from('chat_blocks')
        .select('blocker_user_id,blocked_user_id')
        .or(`and(blocker_user_id.eq.${senderId},blocked_user_id.in.(${idList})),and(blocked_user_id.eq.${senderId},blocker_user_id.in.(${idList}))`),
    ])
    if (settingsResult.error) throw settingsResult.error
    if (blocksResult.error) throw blocksResult.error

    const blocked = new Set()
    for (const row of blocksResult.data || []) {
      const blocker = validId(row.blocker_user_id)
      const blockedUser = validId(row.blocked_user_id)
      if (blocker === senderId) blocked.add(blockedUser)
      if (blockedUser === senderId) blocked.add(blocker)
    }

    const preferences = new Map((settingsResult.data || []).map((row) => [
      validId(row.user_id),
      row[SETTINGS_COLUMN[tag]],
    ]))
    const followingOnly = ids.filter((id) => !blocked.has(id) && preferences.get(id) === 'following')
    const follows = new Set()

    if (followingOnly.length) {
      const { data: followRows, error: followError } = await database
        .from('user_follows')
        .select('follower_user_id')
        .in('follower_user_id', followingOnly)
        .eq('following_user_id', senderId)
      if (followError) throw followError
      for (const row of followRows || []) follows.add(validId(row.follower_user_id))
    }

    for (const id of ids) {
      if (blocked.has(id)) continue
      const preference = preferences.get(id) || 'everyone'
      if (preference === 'nobody') continue
      if (preference === 'following' && !follows.has(id)) continue
      accepted.push(id)
    }
  }

  return accepted
}
