import { supabase } from '../config/supabase.js'

const PAGE_SIZE = 9
const MAX_PHOTOS = 100
const CATEGORY = 'author_page_avatar'

function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code })
}

function fail(res, error, message) {
  const status = Number(error?.statusCode || 500)
  if (status >= 400 && status < 500) {
    return res.status(status).json({ ok: false, code: error.code || 'INVALID_REQUEST', message: error.message || message })
  }
  console.error('AUTHOR_PROFILE_PHOTO_LIBRARY_ERROR:', error)
  return res.status(500).json({ ok: false, message })
}

function userId(req) {
  return String(req.user?.user_id || req.user?.id || '').trim()
}

async function getPage(req) {
  const id = userId(req)
  if (!id) throw httpError(401, 'LOGIN_REQUIRED', 'Sign in to manage profile pictures')
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id, avatar_url')
    .eq('user_id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) throw httpError(404, 'AUTHOR_PAGE_NOT_FOUND', 'Author page not found')
  return data
}

function parseAssetId(req) {
  const id = String(req.body?.asset_id || req.params?.assetId || '').trim()
  if (!/^[a-zA-Z0-9_-]{4,128}$/.test(id)) {
    throw httpError(400, 'INVALID_PROFILE_PHOTO_ID', 'Invalid profile picture')
  }
  return id
}

async function getOwnAsset(pageId, assetId) {
  const { data, error } = await supabase
    .from('r2_assets')
    .select('id, public_url, asset_status')
    .eq('id', assetId)
    .eq('owner_type', 'author')
    .eq('owner_id', pageId)
    .eq('category', CATEGORY)
    .eq('asset_status', 'active')
    .maybeSingle()
  if (error) throw error
  if (!data || !/^https:\/\//i.test(String(data.public_url || ''))) {
    throw httpError(404, 'PROFILE_PHOTO_NOT_FOUND', 'Profile picture was removed or is not yours')
  }
  return data
}

export async function assertAuthorAvatarUploadAllowed(authorPageId) {
  const { count, error } = await supabase
    .from('r2_assets')
    .select('id', { head: true, count: 'exact' })
    .eq('owner_type', 'author')
    .eq('owner_id', authorPageId)
    .eq('category', CATEGORY)
    .eq('asset_status', 'active')
  if (error) throw error
  if (Number(count || 0) >= MAX_PHOTOS) {
    throw httpError(409, 'AUTHOR_PROFILE_PHOTO_LIMIT_REACHED', 'Profile picture library is full. Remove an older picture first')
  }
}

export async function listMyAuthorProfilePhotos(req, res) {
  try {
    const page = await getPage(req)
    const offset = Number(req.query.offset ?? 0)
    const limit = Number(req.query.limit ?? PAGE_SIZE)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= MAX_PHOTOS ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE) {
      throw httpError(400, 'INVALID_PAGINATION', 'Invalid profile picture page')
    }
    const size = Math.min(limit, MAX_PHOTOS - offset)
    const { data, count, error } = await supabase
      .from('r2_assets')
      .select('id, public_url, created_at', { count: 'exact' })
      .eq('owner_type', 'author')
      .eq('owner_id', page.id)
      .eq('category', CATEGORY)
      .eq('asset_status', 'active')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + size - 1)
    if (error) throw error
    const photos = (data || [])
      .filter((item) => /^https:\/\//i.test(String(item.public_url || '')))
      .map((item) => ({ id: item.id, image_url: item.public_url, created_at: item.created_at }))
    const total = Number(count || 0)
    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).json({
      ok: true,
      photos,
      total,
      offset,
      limit: size,
      maximum: MAX_PHOTOS,
      has_more: offset + (data?.length || 0) < Math.min(total, MAX_PHOTOS),
      current_avatar_url: page.avatar_url || '',
    })
  } catch (error) {
    return fail(res, error, 'Could not load author profile pictures')
  }
}

export async function selectMyAuthorProfilePhoto(req, res) {
  try {
    const page = await getPage(req)
    const asset = await getOwnAsset(page.id, parseAssetId(req))
    const { data, error } = await supabase
      .from('author_pages')
      .update({ avatar_url: asset.public_url, updated_at: new Date().toISOString() })
      .eq('id', page.id)
      .eq('user_id', userId(req))
      .select('id, avatar_url')
      .single()
    if (error) throw error
    return res.status(200).json({ ok: true, avatar_url: data.avatar_url, asset_id: asset.id })
  } catch (error) {
    return fail(res, error, 'Could not choose profile picture')
  }
}

export async function removeMyAuthorProfilePhoto(req, res) {
  try {
    const page = await getPage(req)
    const asset = await getOwnAsset(page.id, parseAssetId(req))
    const { data: latestPage, error: pageError } = await supabase
      .from('author_pages')
      .select('avatar_url')
      .eq('id', page.id)
      .single()
    if (pageError) throw pageError
    if (latestPage?.avatar_url === asset.public_url) {
      throw httpError(409, 'PROFILE_PHOTO_IN_USE', 'Change your current profile picture before removing this one')
    }
    const { data, error } = await supabase
      .from('r2_assets')
      .update({ asset_status: 'deleted' })
      .eq('id', asset.id)
      .eq('owner_type', 'author')
      .eq('owner_id', page.id)
      .eq('category', CATEGORY)
      .eq('asset_status', 'active')
      .select('id')
      .maybeSingle()
    if (error) throw error
    if (!data) throw httpError(409, 'PROFILE_PHOTO_CHANGED', 'Profile picture changed. Refresh the library')
    return res.status(200).json({ ok: true, removed: true, asset_id: asset.id })
  } catch (error) {
    return fail(res, error, 'Could not remove profile picture')
  }
}
