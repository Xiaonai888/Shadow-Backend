import { supabase } from '../config/supabase.js'
import {
  assertR2MediaReference,
  assertR2StorageKey,
} from '../services/mediaStoragePolicy.service.js'

const TABLE = 'profile_frames'
const SELECTIONS = 'reader_profile_frame_selections'
const PAGE_SIZE = 9
const ADMIN_FIELDS = 'id, name, image_url, storage_key, access_tier, is_active, sort_order, created_at, updated_at'
const READER_FIELDS = 'id, name, image_url, access_tier, sort_order'
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
  if (value !== 'free' && value !== 'premium') throw invalid('Access must be Free or Premium')
  return value
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

function adminPatch(body, creating = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Invalid frame data')
  const patch = {}
  if (creating || Object.hasOwn(body, 'name')) patch.name = nameValue(body.name)
  if (creating || Object.hasOwn(body, 'access_tier')) patch.access_tier = accessValue(body.access_tier)
  if (creating || Object.hasOwn(body, 'is_active')) patch.is_active = activeValue(body.is_active)
  if (creating || Object.hasOwn(body, 'sort_order')) patch.sort_order = orderValue(body.sort_order)
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

export async function listAdminProfileFrames(req, res) {
  try {
    res.set('Cache-Control', 'private, no-store')
    const page = pageNumber(req.query.page)
    const access = typeof req.query.access === 'string' ? req.query.access : 'all'
    const status = typeof req.query.status === 'string' ? req.query.status : 'all'
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
    if (!['all', 'free', 'premium'].includes(access)) throw invalid('Invalid access filter')
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
    const { data: existing, error: lookupError } = await supabase
      .from(TABLE)
      .select(ADMIN_FIELDS)
      .eq('storage_key', payload.storage_key)
      .limit(1)
      .maybeSingle()
    if (lookupError) throw lookupError
    if (existing) return res.status(200).json({ ok: true, frame: existing, reused: true })
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
    const payload = adminPatch(req.body)
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
    if (!['all', 'free', 'premium'].includes(access)) throw invalid('Invalid access filter')
    const offset = (page - 1) * PAGE_SIZE
    let query = supabase.from(TABLE)
      .select(READER_FIELDS)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE)
    if (access !== 'all') query = query.eq('access_tier', access)
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
    if (!frame || (frame.access_tier === 'premium' && !(await premiumActive(userId)))) {
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
      if (frame.access_tier === 'premium' && !(await premiumActive(userId))) {
        return res.status(403).json({ ok: false, message: 'Active Premium membership required' })
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
