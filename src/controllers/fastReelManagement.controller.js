import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Include tags so the owner's Edit view can round-trip existing metadata.
const VIDEO_FIELDS = 'id,user_id,video_url,thumbnail_url,title,description,tags,status,access_type,unlock_price_diamonds,published_at,view_count'

function pageNumber(value, fallback, maximum) {
  if (value === undefined || value === '') return fallback
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? Math.min(number, maximum) : null
}

function youtubeId(value) {
  try {
    const url = new URL(String(value || '').trim())
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return ''
    const host = url.hostname.toLowerCase()
    const path = url.pathname.split('/').filter(Boolean)
    let id = ''
    if (['youtu.be', 'www.youtu.be'].includes(host)) id = path[0] || ''
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
      if (path[0] === 'watch') id = url.searchParams.get('v') || ''
      if (['embed', 'shorts', 'live'].includes(path[0])) id = path[1] || ''
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : ''
  } catch {
    return ''
  }
}

// Same normalizer used by createFastVideo: a maximum of 10 normalized tags,
// lowercase, leading '#' stripped, whitespace replaced with '-'.
function normalizeTags(value) {
  if (!Array.isArray(value) || value.length > 40) return null
  const unique = new Set()
  for (const raw of value) {
    if (typeof raw !== 'string') return null
    const tag = raw.trim().replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase().slice(0, 24)
    if (tag) unique.add(tag)
    if (unique.size >= 10) break
  }
  return [...unique]
}

export async function listMyFastReels(req, res) {
  const userId = req.user?.user_id
  if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' })
  const limit = pageNumber(req.query.limit, 12, 30)
  const offset = pageNumber(req.query.offset, 0, 5000)
  if (!limit || offset === null) return res.status(400).json({ ok: false, message: 'Invalid pagination' })
  try {
    const { data, error } = await supabase.from('fast_videos')
      .select(VIDEO_FIELDS)
      .eq('user_id', userId)
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit)
    if (error) throw error
    const results = data || []
    res.set('Cache-Control', 'private, no-store')
    return res.json({
      ok: true,
      videos: results.slice(0, limit),
      pagination: { limit, offset, next_offset: offset + Math.min(results.length, limit), has_more: results.length > limit },
    })
  } catch (error) {
    console.error('FAST REEL MINE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to load your Reels' })
  }
}

export async function updateMyFastReel(req, res) {
  const userId = req.user?.user_id
  if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' })
  if (!UUID.test(String(req.params.id || ''))) return res.status(400).json({ ok: false, message: 'Invalid Reel ID' })

  const input = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const allowed = ['title', 'description', 'video_url', 'status', 'tags']
  const keys = Object.keys(input)
  if (!keys.length || keys.some(key => !allowed.includes(key))) {
    return res.status(400).json({ ok: false, message: 'Invalid Reel fields' })
  }
  const changes = {}
  if (Object.hasOwn(input, 'title')) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 100) {
      return res.status(400).json({ ok: false, message: 'Title must be 1–100 characters' })
    }
    changes.title = input.title.trim()
  }
  if (Object.hasOwn(input, 'description')) {
    if (typeof input.description !== 'string' || input.description.length > 500) {
      return res.status(400).json({ ok: false, message: 'Description must be 500 characters or fewer' })
    }
    changes.description = input.description.trim()
  }
  if (Object.hasOwn(input, 'video_url')) {
    const id = youtubeId(input.video_url)
    if (!id) return res.status(400).json({ ok: false, message: 'A valid YouTube URL is required' })
    changes.video_url = new URL(input.video_url.trim()).toString()
    changes.platform = 'youtube'
    changes.thumbnail_url = `https://img.youtube.com/vi/${id}/hqdefault.jpg`
  }
  if (Object.hasOwn(input, 'status')) {
    if (!['draft', 'published'].includes(input.status)) {
      return res.status(400).json({ ok: false, message: 'Invalid Reel status' })
    }
    changes.status = input.status
  }
  if (Object.hasOwn(input, 'tags')) {
    const normalized = normalizeTags(input.tags)
    if (normalized === null) return res.status(400).json({ ok: false, message: 'Invalid tags' })
    changes.tags = normalized
  }
  try {
    const { data: current, error: readError } = await supabase.from('fast_videos')
      .select('id,status,published_at')
      .eq('id', req.params.id).eq('user_id', userId).maybeSingle()
    if (readError) throw readError
    if (!current) return res.status(404).json({ ok: false, message: 'Reel not found' })
    if (changes.status === 'published' && current.status !== 'published') {
      changes.published_at = new Date().toISOString()
    } else if (changes.status === 'draft') {
      changes.published_at = null
    }
    const { data, error } = await supabase.from('fast_videos')
      .update(changes).eq('id', req.params.id).eq('user_id', userId)
      .select(VIDEO_FIELDS).maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Reel not found' })
    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, video: data })
  } catch (error) {
    console.error('FAST REEL UPDATE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to update Reel' })
  }
}

export async function deleteMyFastReel(req, res) {
  const userId = req.user?.user_id
  if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' })
  if (!UUID.test(String(req.params.id || ''))) return res.status(400).json({ ok: false, message: 'Invalid Reel ID' })
  try {
    const { data, error } = await supabase.from('fast_videos')
      .delete().eq('id', req.params.id).eq('user_id', userId).select('id').maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Reel not found' })
    res.set('Cache-Control', 'private, no-store')
    return res.json({ ok: true, id: data.id })
  } catch (error) {
    console.error('FAST REEL DELETE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to delete Reel' })
  }
}
