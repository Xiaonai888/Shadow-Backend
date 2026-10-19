import { supabase } from '../config/supabase.js'
import { invalidateAdvertisementResponseCache } from '../services/advertisementsResponseCache.service.js'

const placements = new Set(['opening', 'freeUnlock', 'me'])
const settingsFields = new Set(['enabled', 'mode', 'manual_ad_id', 'rotate_every_seconds', 'max_ads', 'restart_rotation'])
const itemFields = new Set(['id', 'enabled', 'in_loop'])
const moveFields = new Set(['item_id', 'target_item_id', 'direction'])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isId(value) {
  return Number.isSafeInteger(value) && value > 0
}

function validSettings(settings) {
  if (!isObject(settings)) return false
  for (const [key, value] of Object.entries(settings)) {
    if (!settingsFields.has(key)) return false
    if (key === 'enabled' || key === 'restart_rotation') {
      if (typeof value !== 'boolean') return false
    } else if (key === 'mode') {
      if (value !== 'manual' && value !== 'auto') return false
    } else if (key === 'manual_ad_id') {
      if (value !== null && !isId(value)) return false
    } else if (key === 'rotate_every_seconds') {
      if (!isId(value) || value > 2592000) return false
    } else if (key === 'max_ads') {
      if (!isId(value) || value > 100) return false
    }
  }
  return true
}

function validItems(items) {
  if (!Array.isArray(items) || items.length > 100) return false
  const ids = new Set()
  for (const item of items) {
    if (!isObject(item) || !isId(item.id) || ids.has(item.id)) return false
    if (!Object.hasOwn(item, 'enabled') && !Object.hasOwn(item, 'in_loop')) return false
    for (const [key, value] of Object.entries(item)) {
      if (!itemFields.has(key)) return false
      if (key !== 'id' && typeof value !== 'boolean') return false
    }
    ids.add(item.id)
  }
  return true
}

function validMoves(moves) {
  if (!Array.isArray(moves) || moves.length > 200) return false
  for (const move of moves) {
    if (!isObject(move) || !isId(move.item_id)) return false
    if (Object.keys(move).some(key => !moveFields.has(key))) return false
    const hasTarget = Object.hasOwn(move, 'target_item_id')
    const hasDirection = Object.hasOwn(move, 'direction')
    if (hasTarget === hasDirection) return false
    if (hasTarget && !isId(move.target_item_id)) return false
    if (hasDirection && move.direction !== 'up' && move.direction !== 'down') return false
  }
  return true
}

export async function saveAdminAdvertisementBatch(req, res) {
  const placement = String(req.params?.placement || '').trim()
  if (!placements.has(placement)) {
    return res.status(400).json({ ok: false, message: 'Invalid advertisement placement' })
  }

  const body = req.body
  if (!isObject(body) || Object.keys(body).some(key => !['settings', 'items', 'moves'].includes(key))) {
    return res.status(400).json({ ok: false, message: 'Invalid advertisement batch payload' })
  }

  const settings = body.settings ?? {}
  const items = body.items ?? []
  const moves = body.moves ?? []
  if (!validSettings(settings) || !validItems(items) || !validMoves(moves)) {
    return res.status(400).json({ ok: false, message: 'Invalid advertisement batch changes' })
  }
  if (!Object.keys(settings).length && !items.length && !moves.length) {
    return res.status(400).json({ ok: false, message: 'No advertisement changes to save' })
  }

  try {
    const actor = String(req.admin?.username || req.admin?.email || 'Admin').slice(0, 120)
    const { data, error } = await supabase.rpc('shadow_save_advertisement_batch', {
      p_placement: placement,
      p_settings: settings,
      p_items: items,
      p_moves: moves,
      p_actor: actor,
    })

    if (error) throw error
    invalidateAdvertisementResponseCache(placement)
    return res.status(200).json({ ok: true, ...data })
  } catch (error) {
    console.error('SAVE ADMIN ADVERTISEMENT BATCH ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.code === 'PGRST202'
        ? 'Advertisement batch SQL function is unavailable'
        : 'Failed to save advertisement changes',
    })
  }
}
