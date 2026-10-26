import { supabase } from '../config/supabase.js'
import {
  assertR2MediaReference,
  assertR2StorageKey,
} from '../services/mediaStoragePolicy.service.js'

const TABLE = 'profile_frames'
const FOLDERS = 'profile_frame_folders'
const SELECTIONS = 'reader_profile_frame_selections'
const PURCHASES = 'reader_profile_frame_purchases'
const PAGE_SIZE = 9
const ADMIN_FIELDS = 'id, name, image_url, storage_key, folder_id, access_tier, coin_price, diamond_price, is_active, sort_order, created_at, updated_at'
const READER_FIELDS = 'id, name, image_url, folder_id, access_tier, coin_price, diamond_price, sort_order'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function invalid(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function sendError(res, error, action) {
  const status = Number(error?.statusCode) || 500
  if (status >= 500) console.error(`PROFILE_FRAMES_${action}:`, error)
  return res.status(status).json({
    ok: false,
    message: status >= 500 ? 'Unable to complete frame request' : error.message,
  })
}

function requiredId(value, field = 'Frame ID') {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`Invalid ${field}`)
  return value
}

function folderValue(value) {
  if (value === null) return null
  return requiredId(value, 'folder ID')
}

async function assertFolderExists(id) {
  if (id === null) return
  const { data, error } = await supabase.from(FOLDERS).select('id').eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) throw invalid('Selected folder does not exist')
}

function folderFilter(req) {
  const raw = req.query.folder_id
  if (raw === undefined || raw === 'all') return { enabled: false, id: null }
  if (raw === 'general') return { enabled: true, id: null }
  if (Array.isArray(raw)) throw invalid('Invalid folder filter')
  return { enabled: true, id: requiredId(raw, 'folder ID') }
}

function applyFolderFilter(query, folder) {
  if (!folder.enabled) return query
  return folder.id === null ? query.is('folder_id', null) : query.eq('folder_id', folder.id)
}

function pageNumber(value) {
  const raw = value === undefined ? 1 : Number(value)
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 10000) throw invalid('Invalid page')
  return raw
}

function selectionUserId(req) {
  const value = req.user?.user_id || req.user?.id
  if (typeof value !== 'string' || !UUID.test(value)) {
    const error = new Error('Reader account required')
    error.statusCode = 401
    throw error
  }
  return value
}

function nameValue(value) {
  if (typeof value !== 'string') throw invalid('Frame name must be text')
  const name = value.trim()
  if (!name || name.length > 100) throw invalid('Frame name must be 1–100 characters')
  return name
}

function accessValue(value) {
  if (!['free', 'premium', 'coins', 'diamonds'].includes(value)) throw invalid('Invalid frame access type')
  return value
}

function priceValue(value, field) {
  const price = Number(value)
  if (!Number.isSafeInteger(price) || price < 0 || price > 1000000000) throw invalid(`Invalid ${field}`)
  return price
}

function activeValue(value) {
  if (typeof value !== 'boolean') throw invalid('Visibility must be true or false')
  return value
}

function orderValue(value) {
  const order = Number(value)
  if (!Number.isSafeInteger(order) || order < 0 || order > 100000) throw invalid('Invalid display order')
  return order
}

function mediaValue(imageUrl, storageKey) {
  const key = assertR2StorageKey(storageKey, { allowEmpty: false })
  const url = assertR2MediaReference(imageUrl, { allowEmpty: false })
  const base = String(process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '')
  if (!key.startsWith('admin-media-library/images/') || !base || url !== `${base}/${key}`) {
    throw invalid('Frame must use a finalized Admin Cloudflare image')
  }
  return { image_url: url, storage_key: key }
}

function adminPatch(body, creating = false, existing = null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Invalid frame data')
  const patch = {}
  if (creating || Object.hasOwn(body, 'name')) patch.name = nameValue(body.name)
  if (creating || Object.hasOwn(body, 'access_tier')) patch.access_tier = accessValue(body.access_tier)
  if (creating || Object.hasOwn(body, 'is_active')) patch.is_active = activeValue(body.is_active)
  if (creating || Object.hasOwn(body, 'sort_order')) patch.sort_order = orderValue(body.sort_order)
  if (Object.hasOwn(body, 'folder_id')) patch.folder_id = folderValue(body.folder_id)
  if (creating || Object.hasOwn(body, 'access_tier') || Object.hasOwn(body, 'coin_price') || Object.hasOwn(body, 'diamond_price')) {
    const tier = patch.access_tier || existing?.access_tier || 'free'
    const coinPrice = tier === 'coins' ? priceValue(body.coin_price ?? existing?.coin_price ?? 0, 'Coin price') : 0
    const diamondPrice = tier === 'diamonds' ? priceValue(body.diamond_price ?? existing?.diamond_price ?? 0, 'Diamond price') : 0
    if (tier === 'coins' && coinPrice === 0) throw invalid('Coin price must be greater than zero')
    if (tier === 'diamonds' && diamondPrice === 0) throw invalid('Diamond price must be greater than zero')
    patch.coin_price = coinPrice
    patch.diamond_price = diamondPrice
  }
  const hasImage = Object.hasOwn(body, 'image_url')
  const hasKey = Object.hasOwn(body, 'storage_key')
  if (creating || hasImage || hasKey) {
    if (!hasImage || !hasKey) throw invalid('Image URL and storage key must be supplied together')
    Object.assign(patch, mediaValue(body.image_url, body.storage_key))
  }
  if (!Object.keys(patch).length) throw invalid('No frame fields to update')
  patch.updated_at = new Date().toISOString()
  return patch
}

async function premiumActive(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('is_premium, premium_expires_at')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw error
  return data?.is_premium === true && Boolean(data.premium_expires_at) && new Date(data.premium_expires_at).getTime() > Date.now()
}

async function visibleFrame(id) {
  const { data, error } = await supabase
    .from(TABLE)
    .select(READER_FIELDS)
    .eq('id', id)
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw error
  return data
}

async function frameAllowed(userId, frame) {
  if (frame.access_tier === 'free') return true
  if (frame.access_tier === 'premium') return premiumActive(userId)
  const { data, error } = await supabase.from(PURCHASES)
    .select('id, expires_at')
    .eq('user_id', userId)
    .eq('frame_id', frame.id)
    .eq('currency', frame.access_tier)
    .order('purchased_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return Boolean(data && (frame.access_tier === 'diamonds' || (data.expires_at && Date.parse(data.expires_at) > Date.now())))
}

export async function listAdminProfileFrames(req, res) {
  try {
    res.set('Cache-Control', 'private, no-store')
    const page = pageNumber(req.query.page)
    const access = typeof req.query.access === 'string' ? req.query.access : 'all'
    const status = typeof req.query.status === 'string' ? req.query.status : 'all'
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
    const folder = folderFilter(req)
    if (!['all', 'free', 'premium', 'coins', 'diamonds'].includes(access)) throw invalid('Invalid access filter')
    if (!['all', 'active', 'hidden'].includes(status)) throw invalid('Invalid status filter')
    if (search.length > 80 || Array.isArray(req.query.search)) throw invalid('Search is too long')
    const offset = (page - 1) * PAGE_SIZE
    let query = supabase.from(TABLE)
      .select(ADMIN_FIELDS, { count: 'exact' })
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
    if (access !== 'all') query = query.eq('access_tier', access)
    if (status !== 'all') query = query.eq('is_active', status === 'active')
    if (search) query = query.ilike('name', `%${search.replace(/[%_\\]/g, '')}%`)
    query = applyFolderFilter(query, folder)
    const { data, count, error } = await query
    if (error) throw error
    const total = Number(count || 0)
    return res.status(200).json({
      ok: true,
      items: data || [],
      pagination: {
        page,
        limit: PAGE_SIZE,
        total,
        total_pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
        has_more: offset + (data?.length || 0) < total,
      },
    })
  } catch (error) {
    return sendError(res, error, 'ADMIN_LIST')
  }
}

export async function createAdminProfileFrame(req, res) {
  try {
    res.set('Cache-Control', 'private, no-store')
    const payload = adminPatch(req.body, true)
    if (Object.hasOwn(payload, 'folder_id')) await assertFolderExists(payload.folder_id)
    const { data: existing, error: lookupError } = await supabase
      .from(TABLE)
      .select(ADMIN_FIELDS)
      .eq('storage_key', payload.storage_key)
      .limit(1)
      .maybeSingle()
    if (lookupError) throw lookupError
    if (existing) {
      if (existing.access_tier !== payload.access_tier || Number(existing.coin_price || 0) !== payload.coin_price || Number(existing.diamond_price || 0) !== payload.diamond_price) {
        return res.status(409).json({ ok: false, message: 'Image already belongs to a frame with different pricing' })
      }
      return res.status(200).json({ ok: true, frame: existing, reused: true })
    }
    const { data, error } = await supabase.from(TABLE).insert(payload).select(ADMIN_FIELDS).single()
    if (error) throw error
    return res.status(201).json({ ok: true, frame: data })
  } catch (error) {
    return sendError(res, error, 'ADMIN_CREATE')
  }
}

export async function updateAdminProfileFrame(req, res) {
  try {
    res.set('Cache-Control', 'private, no-store')
    const id = requiredId(req.params.frameId)
    const { data: existing, error: lookupError } = await supabase.from(TABLE)
      .select('access_tier, coin_price, diamond_price')
      .eq('id', id)
      .maybeSingle()
    if (lookupError) throw lookupError
    if (!existing) return res.status(404).json({ ok: false, message: 'Frame not found' })
    const payload = adminPatch(req.body, false, existing)
    if (Object.hasOwn(payload, 'folder_id')) await assertFolderExists(payload.folder_id)
    const { data, error } = await supabase.from(TABLE)
      .update(payload)
      .eq('id', id)
      .select(ADMIN_FIELDS)
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Frame not found' })
    return res.status(200).json({ ok: true, frame: data })
  } catch (error) {
    return sendError(res, error, 'ADMIN_UPDATE')
  }
}

export async function deleteAdminProfileFrame(req, res) {
  try {
    res.set('Cache-Control', 'private, no-store')
    const id = requiredId(req.params.frameId)
    const { data, error } = await supabase.from(TABLE)
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle()
    if (error?.code === '23503') return res.status(409).json({ ok: false, message: 'Purchased frame cannot be deleted. Hide it instead.' })
    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Frame not found' })
    return res.status(200).json({ ok: true, deleted_id: id })
  } catch (error) {
    return sendError(res, error, 'ADMIN_DELETE')
  }
}

export async function listReaderProfileFrames(req, res) {
  try {
    const page = pageNumber(req.query.page)
    if (!req.user && page > 1) return res.status(401).json({ ok: false, message: 'Sign in to view more frames' })
    const access = typeof req.query.access === 'string' ? req.query.access : 'all'
    const folder = folderFilter(req)
    if (!['all', 'free', 'premium', 'coins', 'diamonds'].includes(access)) throw invalid('Invalid access filter')
    const offset = (page - 1) * PAGE_SIZE
    let query = supabase.from(TABLE)
      .select(READER_FIELDS)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE)
    if (access !== 'all') query = query.eq('access_tier', access)
    query = applyFolderFilter(query, folder)
    const { data, error } = await query
    if (error) throw error
    const items = (data || []).slice(0, PAGE_SIZE)
    res.set('Cache-Control', 'public, max-age=30')
    return res.status(200).json({ ok: true, items, pagination: { page, limit: PAGE_SIZE, has_more: (data?.length || 0) > PAGE_SIZE } })
  } catch (error) {
    return sendError(res, error, 'READER_LIST')
  }
}

export async function getReaderProfileFrameSelection(req, res) {
  try {
    res.set('Cache-Control', 'private, no-store')
    const userId = selectionUserId(req)
    const { data, error } = await supabase.from(SELECTIONS)
      .select('frame_id')
      .eq('user_id', userId)
      .maybeSingle()
    if (error) throw error
    if (!data?.frame_id) return res.status(200).json({ ok: true, frame: null })
    const frame = await visibleFrame(data.frame_id)
    if (!frame || !(await frameAllowed(userId, frame))) {
      return res.status(200).json({ ok: true, frame: null })
    }
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, frame })
  } catch (error) {
    return sendError(res, error, 'READER_SELECTION')
  }
}

export async function setReaderProfileFrameSelection(req, res) {
  try {
    res.set('Cache-Control', 'private, no-store')
    const userId = selectionUserId(req)
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw invalid('Invalid selection')
    const frameId = req.body.frame_id === null ? null : requiredId(req.body.frame_id)
    let frame = null
    if (frameId) {
      frame = await visibleFrame(frameId)
      if (!frame) return res.status(404).json({ ok: false, message: 'Frame unavailable' })
      if (!(await frameAllowed(userId, frame))) {
        return res.status(403).json({ ok: false, message: frame.access_tier === 'premium' ? 'Active Premium membership required' : 'Purchase or renew this frame first' })
      }
    }
    const { error } = await supabase.from(SELECTIONS).upsert({
      user_id: userId,
      frame_id: frameId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
    if (error) throw error
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, frame })
  } catch (error) {
    return sendError(res, error, 'READER_APPLY')
  }
}

export async function listReaderProfileFramePurchases(req, res) {
  try {
    res.set('Cache-Control', 'private, no-store')
    const userId = selectionUserId(req)
    const page = pageNumber(req.query.page)
    const offset = (page - 1) * PAGE_SIZE
    const { data, error } = await supabase.from(PURCHASES)
      .select('id, frame_id, currency, amount, purchased_at, expires_at, frame:profile_frames(id, name, image_url, access_tier, is_active, sort_order, coin_price, diamond_price)')
      .eq('user_id', userId)
      .order('purchased_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE)
    if (error) throw error
    const now = Date.now()
    const items = (data || []).slice(0, PAGE_SIZE).map(item => ({
      ...item,
      valid: Boolean(item.frame?.is_active && item.frame.access_tier === item.currency &&
        (item.currency === 'diamonds' || (item.expires_at && Date.parse(item.expires_at) > now))),
    }))
    return res.status(200).json({ ok: true, items, pagination: { page, limit: PAGE_SIZE, has_more: (data?.length || 0) > PAGE_SIZE } })
  } catch (error) {
    return sendError(res, error, 'READER_PURCHASES')
  }
}

export async function purchaseReaderProfileFrame(req, res) {
  try {
    res.set('Cache-Control', 'private, no-store')
    const userId = selectionUserId(req)
    const frameId = requiredId(req.params.frameId)
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw invalid('Invalid purchase request')
    const key = requiredId(req.body.idempotency_key, 'purchase key')
    const { data, error } = await supabase.rpc('purchase_profile_frame_v1', {
      p_user_id: userId,
      p_frame_id: frameId,
      p_idempotency_key: key,
    })
    if (error?.code === 'PGRST202' || error?.code === '42883') {
      return res.status(503).json({ ok: false, message: 'Frame purchase setup is not ready' })
    }
    if (error?.code === 'P0001') return res.status(409).json({ ok: false, message: error.message })
    if (error?.code === '22023') return res.status(400).json({ ok: false, message: error.message })
    if (error) throw error
    const purchase = Array.isArray(data) ? data[0] : data
    if (!purchase || typeof purchase.charged !== 'boolean' || !['coins', 'diamonds'].includes(purchase.purchase_currency)) {
      throw new Error('Invalid frame purchase result')
    }
    return res.status(200).json({ ok: true, purchase: {
      id: purchase.purchase_id,
      charged: purchase.charged,
      currency: purchase.purchase_currency,
      amount: Number(purchase.amount),
      expires_at: purchase.expires_at,
      wallet_balance: Number(purchase.wallet_balance),
    } })
  } catch (error) {
    return sendError(res, error, 'READER_PURCHASE')
  }
}
