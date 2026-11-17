import { supabase } from '../config/supabase.js'

const TABLE = 'reader_profile_photos'
const PAGE_SIZE = 9
const MAX_PHOTOS = 100

function readerId(req) {
  return String(req.user?.user_id || req.user?.id || '').trim()
}

function validImageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password
  } catch {
    return false
  }
}

async function readCurrentAvatar(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('avatar_url')
    .eq('id', userId)
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw error
  return data?.avatar_url || ''
}

function fail(res, error, fallback) {
  const message = String(error?.message || fallback)
  if (message.includes('PHOTO_LIBRARY_FULL')) {
    return res.status(409).json({ ok: false, code: 'PHOTO_LIBRARY_FULL', message: 'Delete an older profile picture before adding another.' })
  }
  console.error('READER_PROFILE_PHOTOS_ERROR:', error)
  return res.status(500).json({ ok: false, message: fallback })
}

export async function listMyReaderProfilePhotos(req, res) {
  const userId = readerId(req)
  if (!userId) return res.status(401).json({ ok: false, message: 'Authentication required' })
  const requestedOffset = Number(req.query.offset ?? 0)
  if (!Number.isInteger(requestedOffset) || requestedOffset < 0 || requestedOffset >= MAX_PHOTOS) {
    return res.status(400).json({ ok: false, message: 'Invalid photo offset' })
  }
  const requestedLimit = Number(req.query.limit ?? PAGE_SIZE)
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > PAGE_SIZE) {
    return res.status(400).json({ ok: false, message: 'Invalid photo page size' })
  }
  const limit = Math.min(requestedLimit, MAX_PHOTOS - requestedOffset)

  try {
    const { data, error, count } = await supabase
      .from(TABLE)
      .select('id, image_url, created_at', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(requestedOffset, requestedOffset + limit - 1)
    if (error) throw error
    const total = Number(count || 0)
    return res.json({ ok: true, photos: data || [], total, limit, offset: requestedOffset, has_more: requestedOffset + (data?.length || 0) < total, maximum: MAX_PHOTOS })
  } catch (error) {
    return fail(res, error, 'Could not load profile pictures')
  }
}

export async function registerMyReaderProfilePhoto(req, res) {
  const userId = readerId(req)
  if (!userId) return res.status(401).json({ ok: false, message: 'Authentication required' })
  const imageUrl = String(req.body?.image_url || '').trim()
  if (!validImageUrl(imageUrl)) return res.status(400).json({ ok: false, message: 'Valid HTTPS image URL required' })

  try {
    const currentAvatar = await readCurrentAvatar(userId)
    if (currentAvatar !== imageUrl) {
      return res.status(403).json({ ok: false, message: 'Only the current profile picture can be added to this library' })
    }
    const { data: existing, error: existingError } = await supabase
      .from(TABLE)
      .select('id, image_url, created_at')
      .eq('user_id', userId)
      .eq('image_url', imageUrl)
      .maybeSingle()
    if (existingError) throw existingError
    if (existing) return res.json({ ok: true, photo: existing, already_saved: true })

    const { data, error } = await supabase
      .from(TABLE)
      .insert({ user_id: userId, image_url: imageUrl })
      .select('id, image_url, created_at')
      .single()
    if (error?.code === '23505') {
      const result = await supabase
        .from(TABLE)
        .select('id, image_url, created_at')
        .eq('user_id', userId)
        .eq('image_url', imageUrl)
        .maybeSingle()
      if (result.error) throw result.error
      if (result.data) return res.json({ ok: true, photo: result.data, already_saved: true })
    }
    if (error) throw error
    return res.status(201).json({ ok: true, photo: data, already_saved: false })
  } catch (error) {
    return fail(res, error, 'Could not save profile picture to library')
  }
}

export async function removeMyReaderProfilePhoto(req, res) {
  const userId = readerId(req)
  if (!userId) return res.status(401).json({ ok: false, message: 'Authentication required' })
  const photoId = String(req.params.photoId || '').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(photoId)) {
    return res.status(400).json({ ok: false, message: 'Invalid photo ID' })
  }

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('id, image_url')
      .eq('id', photoId)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Photo not found' })
    const currentAvatar = await readCurrentAvatar(userId)
    if (data.image_url === currentAvatar) {
      return res.status(409).json({ ok: false, code: 'CURRENT_PROFILE_PHOTO', message: 'Change your current profile picture before deleting this one' })
    }
    const result = await supabase
      .from(TABLE)
      .delete()
      .eq('id', photoId)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle()
    if (result.error) throw result.error
    return res.json({ ok: true, removed: Boolean(result.data?.id) })
  } catch (error) {
    return fail(res, error, 'Could not remove profile picture')
  }
}
