import { supabase } from '../config/supabase.js'

const DAY = 86400000
const VIDEO_JOIN = 'video:fast_videos!inner(id,user_id,title,thumbnail_url)'
const ACTOR_JOIN = 'actor:users!fast_video_comments_user_id_fkey(id,name,username,avatar_url)'
const COMMENT_COLUMNS = `id,video_id,user_id,parent_id,body,created_at,reply_count,${ACTOR_JOIN},${VIDEO_JOIN}`

function comments(owner, columns = COMMENT_COLUMNS) {
  return supabase.from('fast_video_comments')
    .select(columns)
    .eq('video.user_id', owner)
    .eq('video.status', 'published')
    .is('deleted_at', null)
}

function normalize(row) {
  const actor = Array.isArray(row.actor) ? row.actor[0] : row.actor || {}
  const video = Array.isArray(row.video) ? row.video[0] : row.video || {}
  return {
    id: row.id,
    video_id: row.video_id,
    video_title: video.title || 'Reel',
    video_thumbnail: video.thumbnail_url || '',
    body: row.body || '',
    created_at: row.created_at,
    parent_id: row.parent_id,
    reply_count: Number(row.reply_count || 0),
    actor: {
      id: row.user_id,
      name: actor.name || actor.username || 'Reader',
      username: actor.username || '',
      avatar_url: actor.avatar_url || '',
    },
  }
}

function respondError(res, error, context) {
  console.error('SHADOW_STUDIO_COMMUNITY_ERROR', { context, code: error?.code, message: error?.message })
  return res.status(500).json({ ok: false, message: 'Unable to load Studio Community' })
}

export async function getMyStudioCommunity(req, res) {
  const owner = req.user?.user_id
  if (!owner) return res.status(401).json({ ok: false, message: 'Unauthorized' })
  const view = req.query.view === 'all' ? 'all' : 'overview'
  const limit = view === 'all' ? 12 : 3
  const offset = view === 'all' ? Number(req.query.offset || 0) : 0
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5000) {
    return res.status(400).json({ ok: false, message: 'Invalid offset' })
  }

  try {
    if (view === 'all') {
      const { data, error } = await comments(owner)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + limit)
      if (error) throw error
      const rows = data || []
      return res.json({
        ok: true,
        comments: rows.slice(0, limit).map(normalize),
        pagination: { next_offset: offset + Math.min(limit, rows.length), has_more: rows.length > limit },
      })
    }

    const week = new Date(Date.now() - 7 * DAY).toISOString()
    const days28 = new Date(Date.now() - 28 * DAY).toISOString()
    const [latestResult, countResult, weeklyResult] = await Promise.all([
      comments(owner).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(3),
      supabase.from('fast_video_comments')
        .select(`id,${VIDEO_JOIN}`, { count: 'exact', head: true })
        .eq('video.user_id', owner).eq('video.status', 'published')
        .is('deleted_at', null).gte('created_at', days28),
      comments(owner, `user_id,${VIDEO_JOIN}`)
        .gte('created_at', week).order('created_at', { ascending: false }).limit(1000),
    ])
    if (latestResult.error) throw latestResult.error
    if (countResult.error) throw countResult.error
    if (weeklyResult.error) throw weeklyResult.error

    const counts = new Map()
    for (const item of weeklyResult.data || []) {
      if (item.user_id && item.user_id !== owner) {
        counts.set(item.user_id, (counts.get(item.user_id) || 0) + 1)
      }
    }
    const winners = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)

    let users = []
    if (winners.length) {
      const { data, error } = await supabase.from('users')
        .select('id,name,username,avatar_url')
        .in('id', winners.map(item => item[0]))
      if (error) throw error
      users = data || []
    }
    const people = new Map(users.map(user => [user.id, user]))
    const spotlight = winners.map(([id, count], index) => {
      const person = people.get(id) || {}
      return {
        rank: index + 1,
        user_id: id,
        name: person.name || person.username || 'Reader',
        username: person.username || '',
        avatar_url: person.avatar_url || '',
        comment_count: count,
      }
    })
    const value = {
      ok: true,
      comments: (latestResult.data || []).map(normalize),
      comments_28d: Number(countResult.count || 0),
      spotlight,
      spotlight_sample_limited: (weeklyResult.data || []).length >= 1000,
    }
    return res.json(value)
  } catch (error) {
    return respondError(res, error, view)
  }
}
