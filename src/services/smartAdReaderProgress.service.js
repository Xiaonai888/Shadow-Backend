import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 86400000
const COMPLETED_COOLDOWN_MS = 30 * DAY_MS
const MAX_STORY_IDS = 200
const QUERY_CHUNK = 90

export function classifySmartAdReaderProgress(story, progress, now = Date.now()) {
  if (!progress) return 'unread'

  const publishedCount = Math.floor(Number(story?.episode_count) || 0)
  const lastEpisodeNumber = Math.floor(Number(progress.episode_number) || 0)
  const savedEpisodeCount = Math.floor(Number(progress.total_episodes) || 0)
  const percent = Number(progress.reading_percent) || 0
  const completedAt = Date.parse(progress.last_read_at || '')

  const finished = publishedCount > 0 &&
    savedEpisodeCount >= publishedCount &&
    lastEpisodeNumber >= publishedCount &&
    percent >= 95 &&
    Number.isFinite(completedAt) &&
    completedAt <= now

  if (!finished) return 'in_progress'
  return now - completedAt < COMPLETED_COOLDOWN_MS ? 'cooldown' : 'replay'
}

export async function readSmartAdReaderProgress(readerId, storyIds, { db = supabase } = {}) {
  const userId = String(readerId || '').trim()
  if (!UUID.test(userId)) return new Map()

  const ids = [...new Set((Array.isArray(storyIds) ? storyIds : [])
    .map((id) => String(id || '').toLowerCase())
    .filter((id) => UUID.test(id)))].slice(0, MAX_STORY_IDS)
  if (!ids.length) return new Map()

  const requests = []
  for (let start = 0; start < ids.length; start += QUERY_CHUNK) {
    requests.push(db.from('reading_progress')
      .select('story_id,episode_number,total_episodes,reading_percent,last_read_at')
      .eq('user_id', userId)
      .in('story_id', ids.slice(start, start + QUERY_CHUNK)))
  }

  const results = await Promise.all(requests)
  const progress = new Map()
  for (const result of results) {
    if (result.error) throw result.error
    for (const row of result.data || []) {
      const id = String(row?.story_id || '').toLowerCase()
      if (UUID.test(id)) progress.set(id, row)
    }
  }
  return progress
}
