import { listUnclassifiedStudioVideos, setStudioVideoType } from '../services/shadowStudioVideoType.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(res, error) {
  console.error('[STUDIO_VIDEO_TYPE_ERROR]', { code: error?.code, message: error?.message })
  const missingSchema = ['42703', '42P01', 'PGRST204'].includes(error?.code)
  return res.status(missingSchema ? 503 : 500).json({
    ok: false,
    code: missingSchema ? 'STUDIO_VIDEO_TYPE_SCHEMA_MISSING' : 'STUDIO_VIDEO_TYPE_UNAVAILABLE',
    message: missingSchema ? 'Studio video type migration is not installed.' : 'Unable to update Studio video types.',
  })
}

export async function getUnclassifiedStudioVideos(req, res) {
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit)
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 5000) {
    return res.status(400).json({ ok: false, message: 'Invalid pagination.' })
  }
  try {
    const result = await listUnclassifiedStudioVideos(req.user.user_id, limit, offset)
    return res.set('Cache-Control', 'private, no-store').json({ ok: true, ...result })
  } catch (error) {
    return fail(res, error)
  }
}

export async function patchStudioVideoType(req, res) {
  const videoId = String(req.params.videoId || '')
  const type = req.body?.video_type
  const hasDuration = Object.hasOwn(req.body || {}, 'duration_seconds')
  const duration = req.body?.duration_seconds
  if (!UUID.test(videoId)) return res.status(400).json({ ok: false, message: 'Invalid video ID.' })
  if (!['long', 'short'].includes(type)) {
    return res.status(400).json({ ok: false, message: 'video_type must be long or short.' })
  }
  if (hasDuration && duration !== null &&
      (!Number.isSafeInteger(duration) || duration < 1 || duration > 604800)) {
    return res.status(400).json({ ok: false, message: 'Invalid duration_seconds.' })
  }
  try {
    const video = await setStudioVideoType(
      req.user.user_id,
      videoId,
      type,
      hasDuration ? duration : undefined,
    )
    if (!video) return res.status(404).json({ ok: false, message: 'Video not found.' })
    return res.set('Cache-Control', 'private, no-store').json({ ok: true, video })
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ ok: false, message: error.message })
    return fail(res, error)
  }
}
