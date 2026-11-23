import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const READER_HASH = /^[0-9a-f]{64}$/
const SLOT = /^\d{4}-\d{2}-\d{2}T(?:00|06|12|18):00$/
const LOOKBACK_MS = 7 * 86400000
const HISTORY_LIMIT = 1000
const MAX_IDS_PER_QUERY = 100
const CLEANUP_INTERVAL_MS = 86400000
let lastCleanupAt = 0

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((id) => String(id || '').trim().toLowerCase()).filter((id) => UUID.test(id)))]
}

export async function readSmartPromotionOwnedCounts(readerId, storyIds, { db = supabase } = {}) {
  const result = new Map()
  if (!readerId) return result
  const ids = uniqueIds(storyIds)
  for (let offset = 0; offset < ids.length; offset += MAX_IDS_PER_QUERY) {
    const { data, error } = await db.rpc('smart_promotion_owned_v1', {
      p_reader_id: readerId,
      p_story_ids: ids.slice(offset, offset + MAX_IDS_PER_QUERY),
    })
    if (error) throw error
    for (const item of data || []) {
      const id = String(item.story_id || '').toLowerCase()
      const count = Number(item.owned_locked_episode_count)
      if (UUID.test(id) && Number.isSafeInteger(count) && count >= 0) result.set(id, count)
    }
  }
  return result
}

export async function readSmartPromotionReaderHistory(readerHash, slotKey, { db = supabase, now = Date.now() } = {}) {
  if (!READER_HASH.test(String(readerHash || '')) || !SLOT.test(String(slotKey || ''))) {
    throw new TypeError('Invalid Smart Promotion reader or slot')
  }
  const { data, error } = await db.from('smart_promotion_reader_history_v1')
    .select('story_id,slot_key,position,first_selected_at')
    .eq('reader_hash', readerHash)
    .gte('first_selected_at', new Date(now - LOOKBACK_MS).toISOString())
    .order('first_selected_at', { ascending: false })
    .limit(HISTORY_LIMIT)
  if (error) throw error
  const recent = new Map()
  const selectedThisSlot = []
  for (const item of data || []) {
    const id = String(item.story_id || '').toLowerCase()
    if (!UUID.test(id)) continue
    const seenAt = Date.parse(item.first_selected_at || '')
    if (!Number.isFinite(seenAt)) continue
    if (!recent.has(id) || seenAt < recent.get(id)) recent.set(id, seenAt)
    if (item.slot_key === slotKey) {
      selectedThisSlot.push({ storyId: id, position: Number(item.position) || 0, at: seenAt })
    }
  }
  selectedThisSlot.sort((a, b) => a.at - b.at || a.position - b.position || a.storyId.localeCompare(b.storyId))
  return { recent, selectedThisSlotIds: [...new Set(selectedThisSlot.map((item) => item.storyId))] }
}

export async function recordSmartPromotionSelections(readerHash, slotKey, storyIds, { db = supabase, now = Date.now() } = {}) {
  if (!READER_HASH.test(String(readerHash || '')) || !SLOT.test(String(slotKey || ''))) {
    throw new TypeError('Invalid Smart Promotion reader or slot')
  }
  const ids = uniqueIds(storyIds).slice(0, 3)
  if (!ids.length) return 0
  const rows = ids.map((id, index) => ({
    reader_hash: readerHash,
    slot_key: slotKey,
    story_id: id,
    position: index,
  }))
  const { error } = await db.from('smart_promotion_reader_history_v1')
    .upsert(rows, { onConflict: 'reader_hash,slot_key,story_id', ignoreDuplicates: true })
  if (error) throw error
  if (db === supabase && now - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
    lastCleanupAt = now
    void db.rpc('smart_promotion_prune_history_v1').then(({ error: cleanupError }) => {
      if (cleanupError) console.error('SMART_PROMOTION_HISTORY_CLEANUP_ERROR:', cleanupError)
    }).catch((cleanupError) => {
      console.error('SMART_PROMOTION_HISTORY_CLEANUP_ERROR:', cleanupError)
    })
  }
  return ids.length
}
