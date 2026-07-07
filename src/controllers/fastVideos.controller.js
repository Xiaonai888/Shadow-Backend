import { supabase } from '../config/supabase.js'

function normalizeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeUrl(value) {
  const url = String(value || '').trim()

  try {
    const parsed = new URL(url)

    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

function normalizeTags(value) {
  const source = Array.isArray(value) ? value : []
  const unique = new Set()

  for (const item of source) {
    const tag = String(item || '')
      .trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, '-')
      .toLowerCase()
      .slice(0, 24)

    if (tag) unique.add(tag)
    if (unique.size >= 10) break
  }

  return [...unique]
}

function detectPlatform(videoUrl) {
  const hostname = new URL(videoUrl).hostname.replace(/^www\./, '').toLowerCase()

  if (hostname === 'youtu.be' || hostname.endsWith('youtube.com')) return 'youtube'
  if (hostname.endsWith('vimeo.com')) return 'vimeo'
  if (hostname.endsWith('tiktok.com')) return 'tiktok'
  if (hostname.endsWith('facebook.com') || hostname.endsWith('fb.watch')) return 'facebook'

  return 'external'
}

export async function createFastVideo(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const videoUrl = normalizeUrl(
      req.body.video_url || req.body.videoUrl || req.body.link
    )
    const thumbnailUrl = normalizeUrl(
      req.body.thumbnail_url || req.body.thumbnailUrl
    )
    const title = normalizeText(req.body.title, 100)
    const description = normalizeText(req.body.description, 500)
    const tags = normalizeTags(req.body.tags)
    const accessType = String(
      req.body.access_type || req.body.accessType || req.body.access || 'free'
    )
      .trim()
      .toLowerCase()
    const status = String(req.body.status || 'draft').trim().toLowerCase()
    const requestedPrice = Number(
      req.body.unlock_price_diamonds ??
        req.body.unlockPriceDiamonds ??
        req.body.diamonds ??
        0
    )

    if (!videoUrl) {
      return res.status(400).json({
        ok: false,
        message: 'A valid video URL is required',
      })
    }

    if (!title) {
      return res.status(400).json({
        ok: false,
        message: 'Video title is required',
      })
    }

    if (!thumbnailUrl) {
      return res.status(400).json({
        ok: false,
        message: 'A valid thumbnail URL is required',
      })
    }

    if (!['free', 'paid'].includes(accessType)) {
      return res.status(400).json({
        ok: false,
        message: 'Access type must be free or paid',
      })
    }

    if (!['draft', 'published'].includes(status)) {
      return res.status(400).json({
        ok: false,
        message: 'Status must be draft or published',
      })
    }

    if (
      accessType === 'paid' &&
      (!Number.isInteger(requestedPrice) || requestedPrice < 1)
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Paid videos require at least 1 Diamond',
      })
    }

    const unlockPriceDiamonds = accessType === 'paid' ? requestedPrice : 0

    const { data, error } = await supabase
      .from('fast_videos')
      .insert({
        user_id: userId,
        video_url: videoUrl,
        platform: detectPlatform(videoUrl),
        title,
        description,
        thumbnail_url: thumbnailUrl,
        tags,
        access_type: accessType,
        unlock_price_diamonds: unlockPriceDiamonds,
        status,
        published_at: status === 'published' ? new Date().toISOString() : null,
      })
      .select('*')
      .single()

    if (error) throw error

    return res.status(201).json({
      ok: true,
      message: status === 'published' ? 'Video published successfully' : 'Draft saved successfully',
      video: data,
    })
  } catch (error) {
    console.error('CREATE FAST VIDEO ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to create video',
    })
  }
}
