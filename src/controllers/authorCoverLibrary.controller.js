import { supabase } from '../config/supabase.js'
import { deleteR2ObjectByKey } from '../services/r2Storage.service.js'

const PAGE_SIZE = 9
const MAX_COVERS = 100
const CATEGORY = 'author_page_cover'

function sendError(res, error, message) {
  const status = Number(error?.statusCode || 500)
  if (status >= 400 && status < 500) {
    return res.status(status).json({ ok: false, code: error.code || 'INVALID_REQUEST', message: error.message || message })
  }
  console.error('AUTHOR_COVER_LIBRARY_ERROR:', error)
  return res.status(500).json({ ok: false, message })
}

function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code })
}

function getUserId(req) {
  return String(req.user?.user_id || req.user?.id || '').trim()
}

async function getAuthorPage(req) {
  const userId = getUserId(req)
  if (!userId) throw httpError(401, 'LOGIN_REQUIRED', 'Sign in to manage covers')
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id, cover_url, slide_urls')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw httpError(404, 'AUTHOR_PAGE_NOT_FOUND', 'Author page not found')
  return data
}

function coverIdFromRequest(req) {
  const id = String(req.body?.asset_id || req.params?.assetId || '').trim()
  if (!/^[a-zA-Z0-9_-]{4,128}$/.test(id)) {
    throw httpError(400, 'INVALID_COVER_ID', 'Invalid cover photo')
  }
  return id
}

async function getOwnCover(pageId, assetId) {
  const { data, error } = await supabase
    .from('r2_assets')
    .select('id, public_url, file_path, asset_status')
    .eq('id', assetId)
    .eq('owner_type', 'author')
    .eq('owner_id', pageId)
    .eq('category', CATEGORY)
    .eq('asset_status', 'active')
    .maybeSingle()
  if (error) throw error
  if (!data) throw httpError(404, 'COVER_NOT_FOUND', 'Cover was removed or is not yours')
  return data
}

export async function assertAuthorCoverUploadAllowed(authorPageId) {
  const { count, error } = await supabase
    .from('r2_assets')
    .select('id', { head: true, count: 'exact' })
    .eq('owner_type', 'author')
    .eq('owner_id', authorPageId)
    .eq('category', CATEGORY)
    .eq('asset_status', 'active')
  if (error) throw error
  if (Number(count || 0) >= MAX_COVERS) {
    throw httpError(409, 'AUTHOR_COVER_LIMIT_REACHED', 'Cover library is full. Delete an old cover first')
  }
}

export async function listMyAuthorCovers(req, res) {
  try {
    const page = await getAuthorPage(req)
    const rawOffset = Number(req.query.offset || 0)
    const offset = Number.isSafeInteger(rawOffset) ? Math.max(0, Math.min(MAX_COVERS, rawOffset)) : 0
    const { data, count, error } = await supabase
      .from('r2_assets')
      .select('id, public_url, file_name, created_at', { count: 'exact' })
      .eq('owner_type', 'author')
      .eq('owner_id', page.id)
      .eq('category', CATEGORY)
      .eq('asset_status', 'active')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) throw error
    const items = (data || []).filter(item => /^https:\/\//i.test(String(item.public_url || '')))
    const total = Math.max(0, Number(count || 0))
    const nextOffset = offset + (data || []).length
    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).json({
      ok: true,
      items,
      total,
      limit: PAGE_SIZE,
      max_uploads: MAX_COVERS,
      can_upload: total < MAX_COVERS,
      active_cover_url: page.cover_url || '',
      next_offset: nextOffset,
      has_more: nextOffset < Math.min(total, MAX_COVERS),
    })
  } catch (error) {
    return sendError(res, error, 'Could not load your cover library')
  }
}

export async function selectMyAuthorCover(req, res) {
  try {
    const page = await getAuthorPage(req)
    const asset = await getOwnCover(page.id, coverIdFromRequest(req))
    const { data, error } = await supabase
      .from('author_pages')
      .update({ cover_url: asset.public_url, updated_at: new Date().toISOString() })
      .eq('id', page.id)
      .eq('user_id', getUserId(req))
      .select('id, cover_url')
      .single()
    if (error) throw error
    return res.status(200).json({ ok: true, cover_url: data.cover_url, asset_id: asset.id })
  } catch (error) {
    return sendError(res, error, 'Could not select your cover')
  }
}

export async function deleteMyAuthorCover(req, res) {
  try {
    const page = await getAuthorPage(req)
    const asset = await getOwnCover(page.id, coverIdFromRequest(req))
    const { data: currentPage, error: pageError } = await supabase
      .from('author_pages')
      .select('cover_url, slide_urls')
      .eq('id', page.id)
      .single()
    if (pageError) throw pageError
    if (currentPage.cover_url === asset.public_url || (currentPage.slide_urls || []).includes(asset.public_url)) {
      throw httpError(409, 'COVER_IN_USE', 'This cover is in use. Select another cover before deleting it')
    }
    const path = String(asset.file_path || '')
    if (!path.startsWith(`author-page/covers/${page.id}/`) || path.includes('..')) {
      throw httpError(409, 'COVER_STORAGE_INVALID', 'Cover cannot be safely deleted')
    }
    const { data: reserved, error: reserveError } = await supabase
      .from('r2_assets')
      .update({ asset_status: 'deleted' })
      .eq('id', asset.id)
      .eq('owner_type', 'author')
      .eq('owner_id', page.id)
      .eq('category', CATEGORY)
      .eq('asset_status', 'active')
      .select('id')
      .maybeSingle()
    if (reserveError) throw reserveError
    if (!reserved) throw httpError(409, 'COVER_CHANGED', 'Cover changed. Refresh the library')
    try {
      await deleteR2ObjectByKey(path)
    } catch (error) {
      const { error: restoreError } = await supabase
        .from('r2_assets')
        .update({ asset_status: 'active' })
        .eq('id', asset.id)
        .eq('owner_id', page.id)
        .eq('asset_status', 'deleted')
      if (restoreError) console.error('AUTHOR_COVER_RESTORE_ERROR:', restoreError)
      throw error
    }
    return res.status(200).json({ ok: true, deleted_id: asset.id })
  } catch (error) {
    return sendError(res, error, 'Could not delete your cover')
  }
}
