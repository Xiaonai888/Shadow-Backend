import { supabase } from '../config/supabase.js'
import { assertR2MediaReference, assertR2StorageKey } from '../services/mediaStoragePolicy.service.js'
import {
  uploadMediaLibraryObject,
  deleteMediaLibraryObject,
  deleteMediaLibraryObjects,
} from '../services/mediaLibraryR2.service.js'

// Sticker records never query or modify the existing Character tables.
const FOLDER_TABLE = 'sticker_folders'
const IMAGE_TABLE = 'sticker_library'
const FOLDER_FIELDS = 'id,name,icon,description,cover_image_url,cover_storage_key,sort_order,is_active,created_at,updated_at'
const IMAGE_FIELDS = 'id,folder_id,title,alt_text,image_url,storage_key,sort_order,is_active,animation_type,animation_speed,animation_repeat,created_at,updated_at'
const ANIMATIONS = new Set(['none', 'bounce', 'shake', 'pulse', 'float'])
const SPEEDS = new Set(['slow', 'normal', 'fast'])
const REPEATS = new Set(['once', 'loop'])
const MAX_PAGE = 10000
const PAGE_SIZE = 30

function fail(status, message, code = 'STICKER_INVALID_REQUEST') {
  return Object.assign(new Error(message), { statusCode: status, code })
}
function string(value, limit = 120) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}
function required(value, name, limit = 120) {
  const result = string(value, limit)
  if (!result) throw fail(400, `${name} is required`)
  return result
}
function sortOrder(value) {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0 || n > 1000000000) throw fail(400, 'Invalid sort order')
  return n
}
function visible(value) {
  if (typeof value !== 'boolean') throw fail(400, 'is_active must be true or false')
  return value
}
function option(value, allowed, field) {
  if (!allowed.has(value)) throw fail(400, `Invalid ${field}`)
  return value
}
function identifier(value) {
  const id = String(value || '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw fail(400, 'Invalid ID')
  }
  return id
}
function now() { return new Date().toISOString() }
function ensureDb(error) {
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') {
      throw fail(503, 'Sticker database tables are not installed yet. Run the Sticker SQL migration.', 'STICKER_TABLE_MISSING')
    }
    throw error
  }
}
function handle(handler) {
  return async (req, res) => {
    try { await handler(req, res) }
    catch (error) {
      console.error('ADMIN STICKER LIBRARY ERROR:', error)
      const status = error.statusCode || 500
      res.status(status).json({
        ok: false,
        code: error.code || (status === 500 ? 'STICKER_SERVER_ERROR' : 'STICKER_INVALID_REQUEST'),
        message: status === 500 ? 'Sticker library operation failed. Check backend logs.' : error.message,
      })
    }
  }
}
async function folderById(id) {
  const { data, error } = await supabase.from(FOLDER_TABLE).select(FOLDER_FIELDS).eq('id', identifier(id)).maybeSingle()
  ensureDb(error)
  return data
}
async function imageById(id) {
  const { data, error } = await supabase.from(IMAGE_TABLE).select(IMAGE_FIELDS).eq('id', identifier(id)).maybeSingle()
  ensureDb(error)
  return data
}
async function requireFolder(id) {
  const folder = await folderById(id)
  if (!folder) throw fail(404, 'Sticker folder not found', 'STICKER_FOLDER_NOT_FOUND')
  return folder
}
async function validateImageReference(rawUrl, rawKey) {
  const image_url = assertR2MediaReference(rawUrl, { field: 'sticker_library.image_url', allowEmpty: false })
  const storage_key = assertR2StorageKey(rawKey, { field: 'sticker_library.storage_key', allowEmpty: false })
  // Shared Character uploader stores direct images under the first prefix, fallback under the second.
  if (!['admin-media-library/images/', 'media-library/images/'].some((prefix) => storage_key.startsWith(prefix))) {
    throw fail(400, 'Sticker image must come from the existing Admin Media Library uploader')
  }
  const baseUrl = String(process.env.R2_PUBLIC_URL || process.env.CLOUDFLARE_R2_PUBLIC_URL || '').replace(/\/+$/, '')
  if (!baseUrl || image_url !== `${baseUrl}/${storage_key}`) {
    throw fail(400, 'Image URL and storage key do not match the same Cloudflare object')
  }
  // Never allow one stored R2 object to be owned by both Character and Sticker;
  // deleting one library must not delete an asset still used by the other.
  const checks = await Promise.all([
    supabase.from('media_library').select('id').eq('storage_key', storage_key).limit(1),
    supabase.from(IMAGE_TABLE).select('id').eq('storage_key', storage_key).limit(1),
  ])
  for (const check of checks) ensureDb(check.error)
  if (checks.some((check) => check.data?.length)) throw fail(409, 'This image is already saved in a media library. Upload a new copy.', 'STICKER_IMAGE_ALREADY_USED')
  return { image_url, storage_key }
}

export const listStickers = handle(async (req, res) => {
  const folderId = typeof req.query.folder_id === 'string' ? req.query.folder_id : ''
  const foldersOnly = req.query.folders_only === '1'
  const imagesOnly = req.query.images_only === '1'
  const page = Number(req.query.page || 1)
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) throw fail(400, 'Invalid page')
  if (imagesOnly && !folderId) throw fail(400, 'folder_id is required')
  if (folderId) identifier(folderId)
  const folderQuery = imagesOnly
    ? Promise.resolve({ data: [], error: null })
    : supabase.from(FOLDER_TABLE).select(FOLDER_FIELDS).order('sort_order', { ascending: true }).order('created_at', { ascending: true })
  const imageQuery = foldersOnly || !folderId
    ? Promise.resolve({ data: [], error: null })
    : supabase.from(IMAGE_TABLE).select(IMAGE_FIELDS).eq('folder_id', folderId)
      .order('sort_order', { ascending: true }).order('created_at', { ascending: false })
      .order('id', { ascending: true }).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const [folderResult, imageResult] = await Promise.all([folderQuery, imageQuery])
  ensureDb(folderResult.error)
  ensureDb(imageResult.error)
  const list = imageResult.data || []
  res.json({ ok: true, folders: folderResult.data || [], images: list.slice(0, PAGE_SIZE),
    folder_id: folderId || null, page, limit: PAGE_SIZE, has_more: list.length > PAGE_SIZE })
})

export const createStickerFolder = handle(async (req, res) => {
  const body = req.body || {}
  const row = {
    name: required(body.name, 'Folder name', 100),
    icon: string(body.icon, 20) || '📁',
    description: string(body.description, 300),
    sort_order: sortOrder(body.sort_order ?? 0),
    is_active: visible(body.is_active ?? true),
    updated_at: now(),
  }
  const { data, error } = await supabase.from(FOLDER_TABLE).insert(row).select(FOLDER_FIELDS).single()
  ensureDb(error)
  res.status(201).json({ ok: true, folder: data })
})

export const updateStickerFolder = handle(async (req, res) => {
  await requireFolder(req.params.folderId)
  const b = req.body || {}
  const patch = { updated_at: now() }
  if (Object.hasOwn(b, 'name')) patch.name = required(b.name, 'Folder name', 100)
  if (Object.hasOwn(b, 'icon')) patch.icon = string(b.icon, 20) || '📁'
  if (Object.hasOwn(b, 'description')) patch.description = string(b.description, 300)
  if (Object.hasOwn(b, 'sort_order')) patch.sort_order = sortOrder(b.sort_order)
  if (Object.hasOwn(b, 'is_active')) patch.is_active = visible(b.is_active)
  const { data, error } = await supabase.from(FOLDER_TABLE).update(patch).eq('id', req.params.folderId).select(FOLDER_FIELDS).single()
  ensureDb(error)
  res.json({ ok: true, folder: data })
})

export const uploadStickerCover = handle(async (req, res) => {
  if (!req.file) throw fail(400, 'Folder cover image is required')
  const folder = await requireFolder(req.params.folderId)
  let uploaded
  try {
    uploaded = await uploadMediaLibraryObject({ file: req.file, prefix: `sticker-library/folders/${folder.id}` })
    const { data, error } = await supabase.from(FOLDER_TABLE).update({
      cover_image_url: uploaded.image_url, cover_storage_key: uploaded.storage_key, updated_at: now(),
    }).eq('id', folder.id).select(FOLDER_FIELDS).single()
    ensureDb(error)
    let cleanup_warning = null
    if (folder.cover_storage_key && folder.cover_storage_key !== uploaded.storage_key) {
      try { await deleteMediaLibraryObject(folder.cover_storage_key) }
      catch (e) { cleanup_warning = e.message }
    }
    res.json({ ok: true, folder: data, cleanup_warning })
  } catch (e) {
    if (uploaded?.storage_key) await deleteMediaLibraryObject(uploaded.storage_key).catch(() => {})
    throw e
  }
})

export const deleteStickerCover = handle(async (req, res) => {
  const folder = await requireFolder(req.params.folderId)
  const { data, error } = await supabase.from(FOLDER_TABLE).update({
    cover_image_url: null, cover_storage_key: null, updated_at: now(),
  }).eq('id', folder.id).select(FOLDER_FIELDS).single()
  ensureDb(error)
  let cleanup_warning = null
  if (folder.cover_storage_key) {
    try { await deleteMediaLibraryObject(folder.cover_storage_key) }
    catch (e) { cleanup_warning = e.message }
  }
  res.json({ ok: true, folder: data, cleanup_warning })
})

export const deleteStickerFolder = handle(async (req, res) => {
  const folder = await requireFolder(req.params.folderId)
  // Cursor pagination avoids holding a huge unbounded list in one Supabase request.
  const keys = new Set(folder.cover_storage_key ? [folder.cover_storage_key] : [])
  let lastId = ''
  let imageCount = 0
  while (true) {
    let query = supabase.from(IMAGE_TABLE).select('id,storage_key').eq('folder_id', folder.id)
      .order('id', { ascending: true }).limit(500)
    if (lastId) query = query.gt('id', lastId)
    const { data, error } = await query
    ensureDb(error)
    if (!data?.length) break
    imageCount += data.length
    for (const item of data) if (item.storage_key) keys.add(item.storage_key)
    lastId = data.at(-1).id
    if (data.length < 500) break
  }
  // sticker_library.folder_id ON DELETE CASCADE is installed by the next SQL step.
  const { error } = await supabase.from(FOLDER_TABLE).delete().eq('id', folder.id)
  ensureDb(error)
  let cleanup_warning = null
  let deleted_r2_objects = 0
  try {
    const result = await deleteMediaLibraryObjects([...keys])
    deleted_r2_objects = result.deleted || 0
  } catch (e) { cleanup_warning = e.message }
  res.json({ ok: true, deleted_images: imageCount, deleted_r2_objects, cleanup_warning })
})

export const createStickerImage = handle(async (req, res) => {
  const b = req.body || {}
  const folder = await requireFolder(b.folder_id)
  const url = await validateImageReference(b.image_url, b.storage_key)
  const row = {
    folder_id: folder.id,
    title: required(b.title, 'Sticker title', 120),
    alt_text: string(b.alt_text || b.title, 180),
    ...url,
    sort_order: sortOrder(b.sort_order ?? 0),
    is_active: visible(b.is_active ?? true),
    animation_type: option(b.animation_type ?? 'none', ANIMATIONS, 'animation type'),
    animation_speed: option(b.animation_speed ?? 'normal', SPEEDS, 'animation speed'),
    animation_repeat: option(b.animation_repeat ?? 'loop', REPEATS, 'animation repeat'),
    updated_at: now(),
  }
  const { data, error } = await supabase.from(IMAGE_TABLE).insert(row).select(IMAGE_FIELDS).single()
  ensureDb(error)
  res.status(201).json({ ok: true, image: data })
})

export const updateStickerImage = handle(async (req, res) => {
  const item = await imageById(req.params.imageId)
  if (!item) throw fail(404, 'Sticker image not found', 'STICKER_IMAGE_NOT_FOUND')
  const b = req.body || {}
  const patch = { updated_at: now() }
  if (Object.hasOwn(b, 'folder_id')) patch.folder_id = (await requireFolder(b.folder_id)).id
  if (Object.hasOwn(b, 'title')) patch.title = required(b.title, 'Sticker title', 120)
  if (Object.hasOwn(b, 'alt_text')) patch.alt_text = string(b.alt_text, 180)
  if (Object.hasOwn(b, 'sort_order')) patch.sort_order = sortOrder(b.sort_order)
  if (Object.hasOwn(b, 'is_active')) patch.is_active = visible(b.is_active)
  if (Object.hasOwn(b, 'animation_type')) patch.animation_type = option(b.animation_type, ANIMATIONS, 'animation type')
  if (Object.hasOwn(b, 'animation_speed')) patch.animation_speed = option(b.animation_speed, SPEEDS, 'animation speed')
  if (Object.hasOwn(b, 'animation_repeat')) patch.animation_repeat = option(b.animation_repeat, REPEATS, 'animation repeat')
  // Storage keys and URLs are deliberately immutable: changing CSS animation
  // never re-uploads, re-compresses or changes the source image.
  const { data, error } = await supabase.from(IMAGE_TABLE).update(patch)
    .eq('id', item.id).select(IMAGE_FIELDS).single()
  ensureDb(error)
  res.json({ ok: true, image: data })
})

export const deleteStickerImage = handle(async (req, res) => {
  const item = await imageById(req.params.imageId)
  if (!item) throw fail(404, 'Sticker image not found', 'STICKER_IMAGE_NOT_FOUND')
  const { error } = await supabase.from(IMAGE_TABLE).delete().eq('id', item.id)
  ensureDb(error)
  let cleanup_warning = null
  if (item.storage_key) {
    try { await deleteMediaLibraryObject(item.storage_key) }
    catch (e) { cleanup_warning = e.message }
  }
  res.json({ ok: true, cleanup_warning })
})
