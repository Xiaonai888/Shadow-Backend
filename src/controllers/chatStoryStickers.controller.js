import { supabase } from '../config/supabase.js'

const PACKS = 'chat_story_sticker_pack_catalog'
const SAVED = 'chat_story_sticker_saved_packs'
const FAVORITES = 'chat_story_sticker_favorites'
const RECENT = 'chat_story_sticker_recent'
const IMAGES = 'sticker_library'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IMAGE_FIELDS = 'id,folder_id,title,alt_text,image_url,animation_type,animation_speed,animation_repeat,sort_order'

function sendError(res, error) {
  if (error?.statusCode) return res.status(error.statusCode).json({ ok: false, message: error.message })
  console.error('CHAT_STORY_STICKER_ERROR', error)
  const missing = ['42P01', 'PGRST205', '42883'].includes(error?.code)
  return res.status(missing ? 503 : 500).json({
    ok: false,
    code: missing ? 'STICKER_SETUP_REQUIRED' : 'STICKER_REQUEST_FAILED',
    message: missing ? 'Chat Story sticker tables have not been installed yet.' : 'Sticker request failed.',
  })
}

function route(handler) {
  return async (req, res) => {
    try { await handler(req, res) } catch (error) { sendError(res, error) }
  }
}

function reject(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode })
}

function asId(value) {
  const id = String(value || '').trim()
  if (!UUID.test(id)) reject(400, 'Invalid sticker ID')
  return id
}

function userId(req) {
  return asId(req.user?.user_id)
}

function pageNumber(raw, fallback, maximum) {
  const n = Number(raw === undefined ? fallback : raw)
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) reject(400, 'Invalid page number')
  return n
}

async function db(query) {
  const { data, error, count } = await query
  if (error) throw error
  return { data: data || [], count }
}

function imageModel(image) {
  return {
    id: image.id,
    folderId: image.folder_id,
    title: image.title || '',
    altText: image.alt_text || '',
    imageUrl: image.image_url,
    animationType: image.animation_type || 'none',
    animationSpeed: image.animation_speed || 'normal',
    animationRepeat: image.animation_repeat || 'loop',
  }
}

function packModel(pack, trendingScore = 0) {
  return { id: pack.id, name: pack.name, icon: pack.icon || '📁', description: pack.description || '', coverUrl: pack.cover_image_url || pack.preview_url || '', imageCount: pack.image_count, trendingScore }
}

async function activeFolder(folderId) {
  const { data } = await db(supabase.from(PACKS).select('id').eq('id', folderId).gt('image_count', 0).limit(1))
  return data.length > 0
}

async function activeImage(imageId) {
  const { data } = await db(supabase.from(IMAGES).select(IMAGE_FIELDS).eq('id', imageId).eq('is_active', true).maybeSingle())
  const image = data && !Array.isArray(data) ? data : null
  return image && await activeFolder(image.folder_id) ? image : null
}

export const getStickerPacks = route(async (req, res) => {
  const page = pageNumber(req.query.page, 1, 10000)
  const limit = Math.min(pageNumber(req.query.limit, 24, 60), 60)
  const search = String(req.query.search || '').trim().slice(0, 80)
  const order = req.query.sort === 'trending' ? 'trending' : 'default'
  const offset = (page - 1) * limit
  const escaped = search.replace(/[%_,\\]/g, character => '\\' + character)
  if (order === 'default') {
    let query = supabase.from(PACKS).select('*', { count: 'exact' }).gt('image_count', 0)
    if (escaped) query = query.ilike('name', `%${escaped}%`)
    const { data, count } = await db(query.order('sort_order', { ascending: true }).order('name', { ascending: true }).range(offset, offset + limit - 1))
    res.set('Cache-Control', 'private, max-age=60')
    return res.json({ ok: true, packs: data.map(pack => packModel(pack)), page, total: count || 0, hasMore: offset + limit < (count || 0) })
  }
  const [catalog, scores] = await Promise.all([
    db(supabase.from(PACKS).select('*').gt('image_count', 0).order('sort_order', { ascending: true }).limit(1000)),
    db(supabase.from('chat_story_sticker_trending_7d').select('folder_id,score').order('score', { ascending: false }).limit(1000)),
  ])
  const scoreMap = new Map(scores.data.map(row => [row.folder_id, Number(row.score || 0)]))
  const matching = escaped ? catalog.data.filter(pack => pack.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) : catalog.data
  matching.sort((a, b) => (scoreMap.get(b.id) || 0) - (scoreMap.get(a.id) || 0) || a.sort_order - b.sort_order)
  const total = matching.length
  res.set('Cache-Control', 'private, max-age=60')
  res.json({ ok: true, packs: matching.slice(offset, offset + limit).map(pack => packModel(pack, scoreMap.get(pack.id) || 0)), page, total, hasMore: offset + limit < total })
})

export const getPackStickers = route(async (req, res) => {
  const folderId = asId(req.params.folderId)
  if (!await activeFolder(folderId)) reject(404, 'Sticker pack is unavailable')
  const page = pageNumber(req.query.page, 1, 10000)
  const limit = Math.min(pageNumber(req.query.limit, 36, 60), 60)
  const start = (page - 1) * limit
  const { data } = await db(supabase.from(IMAGES).select(IMAGE_FIELDS).eq('folder_id', folderId)
    .eq('is_active', true).order('sort_order', { ascending: true }).order('created_at', { ascending: true })
    .order('id', { ascending: true }).range(start, start + limit))
  res.set('Cache-Control', 'private, max-age=60')
  res.json({ ok: true, images: data.slice(0, limit).map(imageModel), page, hasMore: data.length > limit })
})

export const getMyStickerCollection = route(async (req, res) => {
  const uid = userId(req)
  const [saved, favorites, recent] = await Promise.all([
    db(supabase.from(SAVED).select('folder_id,sort_order').eq('user_id', uid).order('sort_order', { ascending: true }).limit(250)),
    db(supabase.from(FAVORITES).select('image_id').eq('user_id', uid).order('created_at', { ascending: false }).limit(100)),
    db(supabase.from(RECENT).select('image_id').eq('user_id', uid).order('used_at', { ascending: false }).limit(48)),
  ])
  const savedPackIds = saved.data.map(x => x.folder_id)
  const savedPacks = savedPackIds.length ? await db(supabase.from(PACKS).select('*').in('id', savedPackIds)) : { data: [] }
  const savedPackMap = new Map(savedPacks.data.map(x => [x.id, x]))
  const imageIds = [...new Set([...favorites.data.map(x => x.image_id), ...recent.data.map(x => x.image_id)])]
  const images = imageIds.length ? await db(supabase.from(IMAGES).select(IMAGE_FIELDS).in('id', imageIds).eq('is_active', true)) : { data: [] }
  const activeFolders = images.data.length ? await db(supabase.from(PACKS).select('id').in('id', [...new Set(images.data.map(x => x.folder_id))])) : { data: [] }
  const folderIds = new Set(activeFolders.data.map(x => x.id))
  const imageMap = new Map(images.data.filter(x => folderIds.has(x.folder_id)).map(x => [x.id, imageModel(x)]))
  res.set('Cache-Control', 'no-store')
  res.json({ ok: true,
    packIds: savedPackIds,
    savedPacks: savedPackIds.map(id => savedPackMap.get(id)).filter(Boolean).map(pack => packModel(pack)),
    favorites: favorites.data.map(x => imageMap.get(x.image_id)).filter(Boolean),
    recent: recent.data.map(x => imageMap.get(x.image_id)).filter(Boolean),
  })
})

export const addMyStickerPack = route(async (req, res) => {
  const uid = userId(req)
  const folderId = asId(req.body?.folderId)
  if (!await activeFolder(folderId)) reject(404, 'Sticker pack is unavailable')
  const current = await db(supabase.from(SAVED).select('folder_id,sort_order').eq('user_id', uid).order('sort_order', { ascending: false }).limit(250))
  const existing = current.data.find(x => x.folder_id === folderId)
  if (!existing && current.data.length >= 200) reject(400, 'Maximum 200 saved packs')
  if (!existing) await db(supabase.from(SAVED).insert({ user_id: uid, folder_id: folderId, sort_order: (current.data[0]?.sort_order || 0) + 1 }))
  res.json({ ok: true, folderId })
})

export const removeMyStickerPack = route(async (req, res) => {
  await db(supabase.from(SAVED).delete().eq('user_id', userId(req)).eq('folder_id', asId(req.params.folderId)))
  res.json({ ok: true })
})

export const reorderMyStickerPacks = route(async (req, res) => {
  const uid = userId(req)
  const ids = req.body?.folderIds
  if (!Array.isArray(ids) || ids.length > 200 || ids.some(x => !UUID.test(x)) || new Set(ids).size !== ids.length) reject(400, 'Invalid pack order')
  const existing = await db(supabase.from(SAVED).select('folder_id').eq('user_id', uid).limit(250))
  if (existing.data.length !== ids.length || !existing.data.every(x => ids.includes(x.folder_id))) reject(409, 'Saved pack list changed; reload and retry')
  const payload = ids.map((id, index) => ({ user_id: uid, folder_id: id, sort_order: index + 1 }))
  if (payload.length) await db(supabase.from(SAVED).upsert(payload, { onConflict: 'user_id,folder_id' }))
  res.json({ ok: true })
})

export const addStickerFavorite = route(async (req, res) => {
  const uid = userId(req)
  const imageId = asId(req.body?.imageId)
  if (!await activeImage(imageId)) reject(404, 'Sticker is unavailable')
  const { count, error } = await supabase.from(FAVORITES).select('image_id', { count: 'exact', head: true }).eq('user_id', uid)
  if (error) throw error
  if (count >= 100) reject(400, 'Maximum 100 favorite stickers')
  await db(supabase.from(FAVORITES).upsert({ user_id: uid, image_id: imageId }, { onConflict: 'user_id,image_id' }))
  res.json({ ok: true })
})

export const removeStickerFavorite = route(async (req, res) => {
  await db(supabase.from(FAVORITES).delete().eq('user_id', userId(req)).eq('image_id', asId(req.params.imageId)))
  res.json({ ok: true })
})

export const recordStickerUse = route(async (req, res) => {
  const uid = userId(req)
  const imageId = asId(req.body?.imageId)
  const { error } = await supabase.rpc('chat_story_record_sticker_use', { p_user_id: uid, p_image_id: imageId })
  if (error?.message?.includes('Sticker is not available')) reject(404, 'Sticker is unavailable')
  if (error) throw error
  res.json({ ok: true })
})
