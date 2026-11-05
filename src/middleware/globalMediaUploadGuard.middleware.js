import {
  assertDiskBackedUploadRequest,
  assertNoInlineMediaReferences,
  assertNoNonR2MediaReferences,
} from '../services/mediaStoragePolicy.service.js'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH'])

const FROZEN_PATH_PREFIXES = [
  '/api/author-stories',
  '/api/reader-stories',
]

const TRUSTED_YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be',
])

function requestPath(req) {
  return String(req.originalUrl || req.url || '')
    .split('?')[0]
    .trim()
}

function isFrozenPath(path) {
  const input = String(path || '').toLowerCase()

  return (
    FROZEN_PATH_PREFIXES.some((prefix) =>
      input.startsWith(prefix)
    ) || input.includes('/manga')
  )
}

// YouTube videos are external links, not files uploaded to R2.
// Apply the exception ONLY to verified video links on Fast/Reel write routes.
function trustedYouTubeVideoId(value) {
  if (typeof value !== 'string' || value.length > 2048) return ''

  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password) return ''
    const host = url.hostname.toLowerCase()
    if (!TRUSTED_YOUTUBE_HOSTS.has(host)) return ''

    const segments = url.pathname.split('/').filter(Boolean)
    let id = ''
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      if (segments.length !== 1) return ''
      id = segments[0]
    } else if (segments.length === 1 && segments[0] === 'watch') {
      id = url.searchParams.get('v') || ''
    } else if (segments.length === 2 && ['shorts', 'embed', 'live'].includes(segments[0])) {
      id = segments[1]
    }

    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : ''
  } catch {
    return ''
  }
}

// The auto-thumbnail must be on YouTube's own image host and match the video ID.
function trustedYouTubeThumbnailId(value) {
  if (typeof value !== 'string' || value.length > 2048) return ''

  try {
    const url = new URL(value.trim())
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== 'img.youtube.com' ||
      url.username || url.password || url.search || url.hash
    ) return ''

    const match = /^\/vi\/([A-Za-z0-9_-]{11})\/(?:default|mqdefault|hqdefault|sddefault|maxresdefault)\.jpg$/.exec(url.pathname)
    return match?.[1] || ''
  } catch {
    return ''
  }
}

function isFastReelWrite(req, path) {
  const method = String(req.method || '').toUpperCase()
  return (
    (method === 'POST' && path === '/api/fast/videos') ||
    (method === 'PATCH' && /^\/api\/fast\/videos\/[^/]+$/.test(path))
  )
}

function isLegacyCompatibleMutation(req, path) {
  const method = String(req.method || '').toUpperCase()

  if (
    method === 'PUT' &&
    (path === '/api/authors/avatar' ||
      path === '/api/authors/profile-images')
  ) {
    return true
  }

  if (
    method === 'PATCH' &&
    /^\/api\/authors\/me\/posts\/[^/]+$/.test(path)
  ) {
    return true
  }

  if (
    method === 'PATCH' &&
    /^\/api\/reader-posts\/me\/[^/]+$/.test(path)
  ) {
    return true
  }

  return false
}

function mediaPolicyBody(req, path) {
  const method = String(req.method || '').toUpperCase()

  if (method === 'POST' && path === '/api/authors/me/payment-methods') {
    const body = { ...(req.body || {}) }
    delete body.qr_image_url
    delete body.qrImageUrl
    return body
  }

  if (isFastReelWrite(req, path) && req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    const checkedBody = { ...req.body }
    const videoId = trustedYouTubeVideoId(checkedBody.video_url)
    if (videoId) {
      delete checkedBody.video_url
      if (trustedYouTubeThumbnailId(checkedBody.thumbnail_url) === videoId) {
        delete checkedBody.thumbnail_url
      }
    }
    // Never modify req.body; the Fast controller receives and validates the original payload.
    return checkedBody
  }

  return req.body
}

function sendPolicyError(res, error) {
  const detail = String(error?.message || '')
  const issue = /inline|base64/i.test(detail)
    ? {
        reason_code: 'MEDIA_UPLOAD_REQUIRED',
        message: 'This file has not been uploaded correctly. Please upload it before continuing.',
      }
    : /RAM-backed|disk-backed/i.test(detail)
      ? {
          reason_code: 'MEDIA_PROCESSING_FAILED',
          message: 'This file could not be processed. Please select it again and retry.',
        }
      : /storage|Cloudflare|Supabase|media|file|url|key/i.test(detail)
        ? {
            reason_code: 'MEDIA_REFERENCE_INVALID',
            message: 'The uploaded file link could not be verified. Please upload the file again.',
          }
        : {
            reason_code: 'MEDIA_VALIDATION_FAILED',
            message: 'The selected file could not be verified. Please check it and try again.',
          }

  console.warn('MEDIA_POLICY_REJECTED', {
    code: error?.code || 'INVALID_MEDIA_STORAGE',
    detail,
  })

  return res.status(error?.statusCode || 400).json({
    ok: false,
    code: error?.code || 'INVALID_MEDIA_STORAGE',
    reason_code: issue.reason_code,
    message: issue.message,
  })
}

export function globalMediaUploadGuard(req, res, next) {
  if (!WRITE_METHODS.has(String(req.method || '').toUpperCase())) {
    return next()
  }

  const path = requestPath(req)

  if (isFrozenPath(path)) {
    return next()
  }

  try {
    const body = mediaPolicyBody(req, path)
    assertNoInlineMediaReferences(req.body, 'request.body')
    assertNoInlineMediaReferences(req.query, 'request.query')

    if (!isLegacyCompatibleMutation(req, path)) {
      assertNoNonR2MediaReferences(body, 'request.body')
      assertNoNonR2MediaReferences(req.query, 'request.query')
    }

    return next()
  } catch (error) {
    return sendPolicyError(res, error)
  }
}

export function guardDiskBackedUploads(req, res, next) {
  try {
    assertDiskBackedUploadRequest(req)
    assertNoInlineMediaReferences(req.body, 'request.body')
    assertNoNonR2MediaReferences(req.body, 'request.body')
    return next()
  } catch (error) {
    return sendPolicyError(res, error)
  }
}
