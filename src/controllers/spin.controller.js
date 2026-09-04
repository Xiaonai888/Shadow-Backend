import { unlink } from 'node:fs/promises'
import { supabase } from '../config/supabase.js'
import {
  deleteR2ObjectByUrl,
  uploadImageToR2AsWebP,
} from '../services/r2Storage.service.js'

const MAX_ENTRIES = 50
const MAX_CUSTOM_GIFTS = 10
const MAX_SAVED_WHEELS = 10
const MAX_HISTORY = 50
const HISTORY_DAYS = 30
const DEFAULT_HISTORY_LIMIT = 20
const MAX_LIST_LIMIT = 50
const MAX_TITLE_LENGTH = 80
const MAX_ENTRY_NAME_LENGTH = 120
const MAX_SECONDARY_LENGTH = 160
const MAX_URL_LENGTH = 1200
const MAX_SOURCE_ID_LENGTH = 180
const MAX_PRIZE_AMOUNT = 1000000000
const WHEEL_SELECT =
  'id, user_id, title, mode, entries, prizes, background_url, options, created_at, updated_at'
const RESULT_SELECT =
  'id, user_id, wheel_id, wheel_title, mode, winner, prize, created_at'
const ENTRY_TYPES = new Set(['manual', 'reader', 'author', 'book'])
const PRIZE_TYPES = new Set(['diamond', 'coin', 'voucher', 'custom'])
const MODES = new Set(['normal', 'shadow'])

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function cleanText(value, maxLength = 120) {
  return String(value || '').trim().slice(0, maxLength)
}

function cleanUrl(value) {
  const text = cleanText(value, MAX_URL_LENGTH)
  if (!text) return ''

  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    return url.toString()
  } catch {
    return ''
  }
}

function cleanUuid(value) {
  const text = cleanText(value, 80)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    text
  )
    ? text
    : null
}

function getLimit(value, fallback, maximum = MAX_LIST_LIMIT) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(1, parsed))
}

function normalizeMode(value) {
  const mode = cleanText(value, 20).toLowerCase()
  return MODES.has(mode) ? mode : 'normal'
}

function normalizeEntry(entry, index = 0) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null
  }

  const rawSourceType = cleanText(entry.source_type, 20).toLowerCase()
  const sourceType = ENTRY_TYPES.has(rawSourceType) ? rawSourceType : 'manual'
  const name = cleanText(entry.name, MAX_ENTRY_NAME_LENGTH)

  if (!name) return null

  const sourceId = cleanText(entry.source_id, MAX_SOURCE_ID_LENGTH)
  const clientId = cleanText(entry.id, MAX_SOURCE_ID_LENGTH)

  return {
    id: clientId || `${sourceType}-${sourceId || index + 1}`,
    source_type: sourceType,
    source_id: sourceId || null,
    name,
    secondary: cleanText(entry.secondary, MAX_SECONDARY_LENGTH),
    image_url: cleanUrl(entry.image_url) || null,
  }
}

function normalizeEntries(value) {
  if (!Array.isArray(value)) return []

  return value
    .slice(0, MAX_ENTRIES)
    .map((entry, index) => normalizeEntry(entry, index))
    .filter(Boolean)
}

function normalizePrize(prize, index = 0) {
  if (!prize || typeof prize !== 'object' || Array.isArray(prize)) {
    return null
  }

  const type = cleanText(prize.type, 20).toLowerCase()
  if (!PRIZE_TYPES.has(type)) return null

  const amount = Math.min(
    MAX_PRIZE_AMOUNT,
    Math.max(0, Math.round(Number(prize.amount || 0)))
  )
  const name =
    cleanText(prize.name, MAX_ENTRY_NAME_LENGTH) ||
    (type === 'diamond'
      ? 'Diamond'
      : type === 'coin'
        ? 'Coin'
        : type === 'voucher'
          ? 'Voucher'
          : '')

  if (type === 'custom' && !name) return null

  const clientId = cleanText(prize.id, MAX_SOURCE_ID_LENGTH)

  return {
    id: clientId || `${type}-${index + 1}`,
    type,
    name,
    amount: type === 'custom' ? 0 : amount,
    image_url: type === 'custom' ? cleanUrl(prize.image_url) || null : null,
  }
}

function normalizePrizes(value) {
  if (!Array.isArray(value)) return []

  const normalized = value
    .slice(0, MAX_CUSTOM_GIFTS + 3)
    .map((item, index) => normalizePrize(item, index))
    .filter(Boolean)

  const custom = normalized
    .filter((item) => item.type === 'custom')
    .slice(0, MAX_CUSTOM_GIFTS)
  const builtIns = []
  const seen = new Set()

  for (const item of normalized) {
    if (item.type === 'custom' || seen.has(item.type)) continue
    seen.add(item.type)
    builtIns.push(item)
  }

  return [...builtIns, ...custom]
}

function normalizeOptions(value) {
  const options =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}

  return {
    no_repeat: Boolean(options.no_repeat),
  }
}

function normalizeWheelPayload(body = {}) {
  const title = cleanText(body.title, MAX_TITLE_LENGTH) || 'Shadow Spin'
  const mode = normalizeMode(body.mode)
  const entries = normalizeEntries(body.entries)
  const prizes = mode === 'shadow' ? normalizePrizes(body.prizes) : []

  if (entries.length < 2) {
    const error = new Error('At least 2 entries are required')
    error.statusCode = 400
    error.code = 'SPIN_ENTRIES_REQUIRED'
    throw error
  }

  return {
    title,
    mode,
    entries,
    prizes,
    background_url: cleanUrl(body.background_url) || null,
    options: normalizeOptions(body.options),
  }
}

function publicWheel(row) {
  if (!row) return null

  return {
    id: row.id,
    title: row.title || 'Shadow Spin',
    mode: normalizeMode(row.mode),
    entries: normalizeEntries(row.entries),
    prizes: normalizePrizes(row.prizes),
    background_url: cleanUrl(row.background_url) || null,
    options: normalizeOptions(row.options),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function publicResult(row) {
  if (!row) return null

  return {
    id: row.id,
    wheel_id: row.wheel_id || null,
    wheel_title: row.wheel_title || 'Shadow Spin',
    mode: normalizeMode(row.mode),
    winner: normalizeEntry(row.winner) || null,
    prize: normalizePrize(row.prize) || null,
    created_at: row.created_at,
  }
}

function collectWheelMediaUrls(row) {
  const urls = new Set()
  const background = cleanUrl(row?.background_url)

  if (background) urls.add(background)

  for (const prize of normalizePrizes(row?.prizes)) {
    if (prize.type === 'custom' && prize.image_url) {
      urls.add(prize.image_url)
    }
  }

  return urls
}

function isOwnedSpinMediaUrl(userId, value) {
  const url = cleanUrl(value)
  const base = String(process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '')

  if (!url || !base || !userId) return false

  return url.startsWith(`${base}/spin/${userId}/`)
}

async function deleteOwnedMediaUrls(userId, urls) {
  for (const url of urls) {
    if (!isOwnedSpinMediaUrl(userId, url)) continue

    await deleteR2ObjectByUrl(url).catch((error) => {
      console.error(
        'SPIN_MEDIA_DELETE_ERROR:',
        JSON.stringify({
          user_id: userId,
          url,
          message: error?.message || '',
        })
      )
    })
  }
}

async function getWheelForUser(userId, wheelId) {
  const id = cleanUuid(wheelId)
  if (!id) return null

  const { data, error } = await supabase
    .from('spin_wheels')
    .select(WHEEL_SELECT)
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  return data || null
}

async function pruneSpinResults(userId) {
  const cutoff = new Date(
    Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()

  const { error: ageError } = await supabase
    .from('spin_results')
    .delete()
    .eq('user_id', userId)
    .lt('created_at', cutoff)

  if (ageError) throw ageError

  const { data: overflowRows, error: overflowError } = await supabase
    .from('spin_results')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(MAX_HISTORY, MAX_HISTORY + 99)

  if (overflowError) throw overflowError

  const overflowIds = (overflowRows || []).map((row) => row.id).filter(Boolean)

  if (overflowIds.length) {
    const { error: deleteError } = await supabase
      .from('spin_results')
      .delete()
      .eq('user_id', userId)
      .in('id', overflowIds)

    if (deleteError) throw deleteError
  }
}

export async function getSpinWheels(req, res) {
  try {
    const userId = getUserId(req)
    const limit = getLimit(req.query.limit, MAX_SAVED_WHEELS, MAX_SAVED_WHEELS)

    const { data, error } = await supabase
      .from('spin_wheels')
      .select(WHEEL_SELECT)
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(limit)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      items: (data || []).map(publicWheel),
      limit,
      max_saved: MAX_SAVED_WHEELS,
    })
  } catch (error) {
    console.error('GET SPIN WHEELS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load saved wheels',
    })
  }
}

export async function createSpinWheel(req, res) {
  try {
    const userId = getUserId(req)
    const payload = normalizeWheelPayload(req.body)

    const { count, error: countError } = await supabase
      .from('spin_wheels')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)

    if (countError) throw countError

    if (Number(count || 0) >= MAX_SAVED_WHEELS) {
      return res.status(409).json({
        ok: false,
        code: 'SPIN_WHEEL_LIMIT',
        message: `You can save up to ${MAX_SAVED_WHEELS} wheels`,
        max_saved: MAX_SAVED_WHEELS,
      })
    }

    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('spin_wheels')
      .insert({
        user_id: userId,
        ...payload,
        created_at: now,
        updated_at: now,
      })
      .select(WHEEL_SELECT)
      .single()

    if (error) throw error

    return res.status(201).json({
      ok: true,
      item: publicWheel(data),
      max_saved: MAX_SAVED_WHEELS,
    })
  } catch (error) {
    console.error('CREATE SPIN WHEEL ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      code: error.code || 'SPIN_WHEEL_CREATE_FAILED',
      message: error.message || 'Failed to save wheel',
    })
  }
}

export async function updateSpinWheel(req, res) {
  try {
    const userId = getUserId(req)
    const existing = await getWheelForUser(userId, req.params.wheelId)

    if (!existing) {
      return res.status(404).json({
        ok: false,
        code: 'SPIN_WHEEL_NOT_FOUND',
        message: 'Saved wheel not found',
      })
    }

    const payload = normalizeWheelPayload(req.body)
    const now = new Date().toISOString()

    const { data, error } = await supabase
      .from('spin_wheels')
      .update({
        ...payload,
        updated_at: now,
      })
      .eq('id', existing.id)
      .eq('user_id', userId)
      .select(WHEEL_SELECT)
      .single()

    if (error) throw error

    const oldUrls = collectWheelMediaUrls(existing)
    const newUrls = collectWheelMediaUrls(data)
    const removedUrls = [...oldUrls].filter((url) => !newUrls.has(url))

    await deleteOwnedMediaUrls(userId, removedUrls)

    return res.status(200).json({
      ok: true,
      item: publicWheel(data),
    })
  } catch (error) {
    console.error('UPDATE SPIN WHEEL ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      code: error.code || 'SPIN_WHEEL_UPDATE_FAILED',
      message: error.message || 'Failed to update wheel',
    })
  }
}

export async function deleteSpinWheel(req, res) {
  try {
    const userId = getUserId(req)
    const existing = await getWheelForUser(userId, req.params.wheelId)

    if (!existing) {
      return res.status(404).json({
        ok: false,
        code: 'SPIN_WHEEL_NOT_FOUND',
        message: 'Saved wheel not found',
      })
    }

    const { error } = await supabase
      .from('spin_wheels')
      .delete()
      .eq('id', existing.id)
      .eq('user_id', userId)

    if (error) throw error

    await deleteOwnedMediaUrls(userId, collectWheelMediaUrls(existing))

    return res.status(200).json({
      ok: true,
      deleted_id: existing.id,
    })
  } catch (error) {
    console.error('DELETE SPIN WHEEL ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to delete wheel',
    })
  }
}

export async function getSpinResults(req, res) {
  try {
    const userId = getUserId(req)
    const limit = getLimit(req.query.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY)
    const cutoff = new Date(
      Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000
    ).toISOString()

    const { data, error } = await supabase
      .from('spin_results')
      .select(RESULT_SELECT)
      .eq('user_id', userId)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      items: (data || []).map(publicResult),
      limit,
      max_history: MAX_HISTORY,
      retention_days: HISTORY_DAYS,
    })
  } catch (error) {
    console.error('GET SPIN RESULTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load spin history',
    })
  }
}

export async function createSpinResult(req, res) {
  try {
    const userId = getUserId(req)
    const winner = normalizeEntry(req.body?.winner)

    if (!winner) {
      return res.status(400).json({
        ok: false,
        code: 'SPIN_WINNER_REQUIRED',
        message: 'Winner is required',
      })
    }

    const wheelId = cleanUuid(req.body?.wheel_id)
    const wheelTitle =
      cleanText(req.body?.wheel_title, MAX_TITLE_LENGTH) || 'Shadow Spin'
    const mode = normalizeMode(req.body?.mode)
    const prize = mode === 'shadow' ? normalizePrize(req.body?.prize) : null
    const now = new Date().toISOString()

    if (wheelId) {
      const savedWheel = await getWheelForUser(userId, wheelId)
      if (!savedWheel) {
        return res.status(400).json({
          ok: false,
          code: 'SPIN_WHEEL_INVALID',
          message: 'Saved wheel does not belong to this account',
        })
      }
    }

    const { data, error } = await supabase
      .from('spin_results')
      .insert({
        user_id: userId,
        wheel_id: wheelId,
        wheel_title: wheelTitle,
        mode,
        winner,
        prize,
        created_at: now,
      })
      .select(RESULT_SELECT)
      .single()

    if (error) throw error

    await pruneSpinResults(userId)

    return res.status(201).json({
      ok: true,
      item: publicResult(data),
      max_history: MAX_HISTORY,
      retention_days: HISTORY_DAYS,
    })
  } catch (error) {
    console.error('CREATE SPIN RESULT ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      code: error.code || 'SPIN_RESULT_CREATE_FAILED',
      message: error.message || 'Failed to save spin result',
    })
  }
}

export async function deleteSpinResult(req, res) {
  try {
    const userId = getUserId(req)
    const resultId = cleanUuid(req.params.resultId)

    if (!resultId) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid result ID',
      })
    }

    const { data, error } = await supabase
      .from('spin_results')
      .delete()
      .eq('id', resultId)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'Spin result not found',
      })
    }

    return res.status(200).json({
      ok: true,
      deleted_id: data.id,
    })
  } catch (error) {
    console.error('DELETE SPIN RESULT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to delete spin result',
    })
  }
}

export async function clearSpinResults(req, res) {
  try {
    const userId = getUserId(req)

    const { error } = await supabase
      .from('spin_results')
      .delete()
      .eq('user_id', userId)

    if (error) throw error

    return res.status(200).json({
      ok: true,
    })
  } catch (error) {
    console.error('CLEAR SPIN RESULTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to clear spin history',
    })
  }
}

export async function uploadSpinMedia(req, res) {
  let uploadedUrl = ''

  try {
    const userId = getUserId(req)

    if (!req.file?.path) {
      return res.status(400).json({
        ok: false,
        code: 'SPIN_IMAGE_REQUIRED',
        message: 'Image is required',
      })
    }

    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])

    if (!allowedTypes.has(String(req.file.mimetype || '').toLowerCase())) {
      return res.status(400).json({
        ok: false,
        code: 'SPIN_IMAGE_TYPE',
        message: 'Only JPG, PNG, and WebP images are allowed',
      })
    }

    const kind = cleanText(req.body?.kind, 20).toLowerCase()
    const folder = kind === 'background' ? 'backgrounds' : 'gifts'
    const oldUrl = cleanUrl(req.body?.old_url)

    if (oldUrl && !isOwnedSpinMediaUrl(userId, oldUrl)) {
      return res.status(400).json({
        ok: false,
        code: 'SPIN_MEDIA_NOT_OWNED',
        message: 'Old image does not belong to this account',
      })
    }

    uploadedUrl = await uploadImageToR2AsWebP(
      req.file,
      `spin/${userId}/${folder}`,
      {
        width: kind === 'background' ? 1600 : 900,
        height: kind === 'background' ? 1000 : 900,
        quality: 82,
        minQuality: 58,
        qualityStep: 6,
        maxBytes: kind === 'background' ? 1200 * 1024 : 700 * 1024,
        fallbackWidth: kind === 'background' ? 960 : 560,
        fit: kind === 'background' ? 'cover' : 'contain',
      }
    )

    if (oldUrl && oldUrl !== uploadedUrl) {
      try {
        await deleteR2ObjectByUrl(oldUrl)
      } catch (error) {
        await deleteR2ObjectByUrl(uploadedUrl).catch(() => {})
        uploadedUrl = ''
        throw error
      }
    }

    return res.status(201).json({
      ok: true,
      image_url: uploadedUrl,
      imageUrl: uploadedUrl,
    })
  } catch (error) {
    console.error('UPLOAD SPIN MEDIA ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      code: error.code || 'SPIN_MEDIA_UPLOAD_FAILED',
      message: error.message || 'Failed to upload spin image',
    })
  } finally {
    if (req.file?.path) {
      await unlink(req.file.path).catch(() => {})
    }
  }
}

export async function deleteSpinMedia(req, res) {
  try {
    const userId = getUserId(req)
    const url = cleanUrl(req.body?.url)

    if (!url || !isOwnedSpinMediaUrl(userId, url)) {
      return res.status(400).json({
        ok: false,
        code: 'SPIN_MEDIA_NOT_OWNED',
        message: 'Image does not belong to this account',
      })
    }

    await deleteR2ObjectByUrl(url)

    return res.status(200).json({
      ok: true,
    })
  } catch (error) {
    console.error('DELETE SPIN MEDIA ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to delete spin image',
    })
  }
}
