import { supabase } from '../config/supabase.js'
import {
  assertR2MediaReference,
} from '../services/mediaStoragePolicy.service.js'
import {
  createMyAuthorPost as createMyAuthorPostOriginal,
  updateMyAuthorPost as updateMyAuthorPostOriginal,
} from './authorPosts.controller.js'

function clean(value) {
  return String(value ?? '').trim()
}

function getImageUrlsFromBody(body = {}) {
  if (Object.prototype.hasOwnProperty.call(body, 'image_urls')) {
    return body.image_urls
  }

  if (Object.prototype.hasOwnProperty.call(body, 'imageUrls')) {
    return body.imageUrls
  }

  return undefined
}

function validateImageUrls(values, existingValues = []) {
  if (!Array.isArray(values)) return

  const existing = new Set(
    (Array.isArray(existingValues) ? existingValues : [])
      .map(clean)
      .filter(Boolean)
  )

  values.forEach((value, index) => {
    const input = clean(value)

    if (!input || existing.has(input)) return

    assertR2MediaReference(input, {
      field: `author_page_posts.image_urls[${index}]`,
      allowEmpty: false,
    })
  })
}

function sendGuardError(res, error) {
  return res.status(error?.statusCode || 400).json({
    ok: false,
    code: error?.code || 'INVALID_MEDIA_STORAGE',
    message: error?.message || 'Invalid post photo URL',
  })
}

export async function createMyAuthorPost(req, res) {
  try {
    validateImageUrls(getImageUrlsFromBody(req.body))
    return createMyAuthorPostOriginal(req, res)
  } catch (error) {
    return sendGuardError(res, error)
  }
}

export async function updateMyAuthorPost(req, res) {
  try {
    const imageUrls = getImageUrlsFromBody(req.body)

    if (!Array.isArray(imageUrls)) {
      return updateMyAuthorPostOriginal(req, res)
    }

    const userId = req.user?.user_id || req.user?.id
    const postId = clean(req.params.postId)

    let existingImageUrls = []

    if (userId && postId) {
      const { data, error } = await supabase
        .from('author_page_posts')
        .select('image_urls')
        .eq('id', postId)
        .eq('user_id', userId)
        .eq('status', 'active')
        .maybeSingle()

      if (error) throw error

      existingImageUrls = Array.isArray(data?.image_urls)
        ? data.image_urls
        : []
    }

    validateImageUrls(imageUrls, existingImageUrls)

    return updateMyAuthorPostOriginal(req, res)
  } catch (error) {
    if (error?.statusCode || error?.code === 'INVALID_MEDIA_STORAGE') {
      return sendGuardError(res, error)
    }

    console.error('AUTHOR POST MEDIA GUARD ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to validate post photos',
      error: error?.message || '',
    })
  }
}
