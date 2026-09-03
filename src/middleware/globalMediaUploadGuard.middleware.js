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

function sendPolicyError(res, error) {
  return res.status(error?.statusCode || 400).json({
    ok: false,
    code: error?.code || 'INVALID_MEDIA_STORAGE',
    message: error?.message || 'Invalid media storage',
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
    assertNoInlineMediaReferences(req.body, 'request.body')
    assertNoInlineMediaReferences(req.query, 'request.query')

    if (!isLegacyCompatibleMutation(req, path)) {
      assertNoNonR2MediaReferences(req.body, 'request.body')
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
