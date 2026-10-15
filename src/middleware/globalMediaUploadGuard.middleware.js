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

  if (method !== 'POST' || path !== '/api/authors/me/payment-methods') {
    return req.body
  }

  const body = { ...(req.body || {}) }
  delete body.qr_image_url
  delete body.qrImageUrl
  return body
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

    assertNoInlineMediaReferences(body, 'request.body')
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
