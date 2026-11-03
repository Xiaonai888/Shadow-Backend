import { supabase } from '../config/supabase.js'

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be',
])

function parseYouTubeUrl(value) {
  if (typeof value !== 'string' || value.trim().length > 2048) return null

  try {
    const url = new URL(value.trim())
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
    if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null

    const host = url.hostname.toLowerCase()
    const segments = url.pathname.split('/').filter(Boolean)
    let id = ''

    if (host === 'youtu.be' || host === 'www.youtu.be') {
      if (segments.length !== 1) return null
      id = segments[0]
    } else if (segments.length === 1 && segments[0] === 'watch') {
      id = url.searchParams.get('v') || ''
    } else if (segments.length === 2 && ['shorts', 'embed', 'live'].includes(segments[0])) {
      id = segments[1]
    }

    if (!YOUTUBE_ID.test(id)) return null
    url.protocol = 'https:'
    return { id, url: url.toString() }
  } catch {
    return null
  }
}

function normalizeThumbnailUrl(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.length > 2048) return null

  try {
    const url = new URL(value.trim())
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

function normalizeTags(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 40) return null

  const unique = new Set()
  for (const item of value) {
    if (typeof item !== 'string') return null
    const tag = item.trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, '-')
      .toLowerCase()
      .slice(0, 24)

    if (tag) unique.add(tag)
    if (unique.size >= 10) break
  }
  return [...unique]
}

export async function createFastVideo(req, res) {
  const userId = req.user?.user_id
  if (!userId) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' })
  }

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body : {}

  const youtube = parseYouTubeUrl(body.video_url ?? body.videoUrl ?? body.link)
  if (!youtube) {
    return res.status(400).json({ ok: false, message: 'A valid YouTube or YouTube Shorts URL is required' })
  }

  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 100) {
    return res.status(400).json({ ok: false, message: 'Video title must be 1–100 characters' })
  }

  const description = body.description ?? ''
  if (typeof description !== 'string' || description.length > 500) {
    return res.status(400).json({ ok: false, message: 'Description must be 500 characters or fewer' })
  }

  const thumbnailInput = normalizeThumbnailUrl(body.thumbnail_url ?? body.thumbnailUrl)
  if (thumbnailInput === null) {
    return res.status(400).json({ ok: false, message: 'A valid thumbnail URL is required' })
  }
  const thumbnailUrl = thumbnailInput || `https://img.youtube.com/vi/${youtube.id}/hqdefault.jpg`

  const tags = normalizeTags(body.tags)
  if (tags === null) {
    return res.status(400).json({ ok: false, message: 'Invalid tags' })
  }

  const accessType = String(body.access_type ?? body.accessType ?? body.access ?? 'free')
    .trim().toLowerCase()
  if (!['free', 'paid'].includes(accessType)) {
    return res.status(400).json({ ok: false, message: 'Access type must be free or paid' })
  }

  const status = String(body.status ?? 'draft').trim().toLowerCase()
  if (!['draft', 'published'].includes(status)) {
    return res.status(400).json({ ok: false, message: 'Status must be draft or published' })
  }

  const requestedPrice = Number(
    body.unlock_price_diamonds ?? body.unlockPriceDiamonds ?? body.diamonds ?? 0
  )
  if (accessType === 'paid' && (!Number.isSafeInteger(requestedPrice) || requestedPrice < 1 || requestedPrice > 1000000)) {
    return res.status(400).json({ ok: false, message: 'Paid videos require a valid Diamond price' })
  }

  try {
    const { data: authorPage, error: authorError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()

    if (authorError) throw authorError
    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        code: 'AUTHOR_PAGE_REQUIRED',
        message: 'An active Author Page is required to publish Reels',
      })
    }

    const { data, error } = await supabase
      .from('fast_videos')
      .insert({
        user_id: userId,
        video_url: youtube.url,
        platform: 'youtube',
        title: body.title.trim(),
        description: description.trim(),
        thumbnail_url: thumbnailUrl,
        tags,
        access_type: accessType,
        unlock_price_diamonds: accessType === 'paid' ? requestedPrice : 0,
        status,
        published_at: status === 'published' ? new Date().toISOString() : null,
      })
      .select('id,user_id,video_url,platform,title,description,thumbnail_url,tags,access_type,unlock_price_diamonds,status,published_at')
      .single()

    if (error) throw error

    res.set('Cache-Control', 'private, no-store')
    return res.status(201).json({
      ok: true,
      message: status === 'published' ? 'Video published successfully' : 'Draft saved successfully',
      video: data,
    })
  } catch (error) {
    console.error('CREATE FAST VIDEO ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create video' })
  }
}
