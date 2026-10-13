import { supabase } from '../config/supabase.js'
import { getReaderAgeAccess } from '../services/storyAgeAccess.service.js'

const PAGE_SIZE = 9
const VALID_TYPES = new Set(['all', 'novel', 'manga', 'chat_story'])
const VALID_TABS = new Set(['recents', 'subscribed'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseCursor(value, tab, type) {
  if (!value) return null
  if (typeof value !== 'string' || value.length > 640) throw new Error('INVALID_CURSOR')
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const score = Number(cursor?.score)
    const timestamp = String(cursor?.at || '')
    const id = String(cursor?.id || '')
    if (
      cursor?.version !== 1 || cursor?.tab !== tab || cursor?.type !== type ||
      !Number.isSafeInteger(score) || score < 0 ||
      !Number.isFinite(Date.parse(timestamp)) || !UUID_PATTERN.test(id)
    ) throw new Error('INVALID_CURSOR')
    return { score, at: new Date(timestamp).toISOString(), id }
  } catch {
    throw new Error('INVALID_CURSOR')
  }
}

function makeCursor(row, tab, type) {
  if (!row) return null
  return Buffer.from(JSON.stringify({
    version: 1,
    tab,
    type,
    score: Number(row.sort_score),
    at: row.sort_at,
    id: row.story_id,
  })).toString('base64url')
}

function normalizeTab(value) {
  const tab = String(value || 'subscribed').trim().toLowerCase()
  return VALID_TABS.has(tab) ? tab : null
}

function normalizeType(value) {
  const raw = String(value || 'all').trim().toLowerCase().replace(/[\s-]+/g, '_')
  return VALID_TYPES.has(raw) ? raw : null
}

function toLibraryItem(row) {
  const status = String(row.story_status || 'New')
  return {
    id: row.collection_id,
    story_id: row.story_id,
    created_at: row.saved_at,
    last_read_at: row.last_read_at || null,
    unread_episode_count: Math.max(0, Number(row.unread_count || 0)),
    last_episode_at: row.last_episode_at || null,
    story: {
      id: row.story_id,
      title: row.title || '',
      cover_url: row.cover_url || '',
      story_type: row.story_type || 'novel',
      main_genre: row.main_genre || '',
      story_status: status,
      status: status.toLowerCase() === 'completed' ? 'completed' : 'ongoing',
      total_episodes: Math.max(0, Number(row.total_episodes || 0)),
    },
  }
}

export async function getReaderLibraryFeedPage(req, res) {
  try {
    const userId = String(req.user?.user_id || req.user?.id || '').trim()
    if (!UUID_PATTERN.test(userId)) {
      return res.status(401).json({ ok: false, message: 'Authentication required' })
    }

    const tab = normalizeTab(req.query.tab)
    const type = normalizeType(req.query.type)
    if (!tab || !type) {
      return res.status(400).json({ ok: false, message: 'Invalid library tab or story type' })
    }

    let cursor
    try {
      cursor = parseCursor(req.query.cursor, tab, type)
    } catch {
      return res.status(400).json({ ok: false, message: 'Invalid library cursor' })
    }

    const ageAccess = await getReaderAgeAccess(req)
    const includeAdult = Boolean(ageAccess?.can_view_adult_stories)
    const args = {
      p_user_id: userId,
      p_tab: tab,
      p_type: type,
      p_cursor_score: cursor?.score ?? null,
      p_cursor_at: cursor?.at ?? null,
      p_cursor_id: cursor?.id ?? null,
      p_include_adult: includeAdult,
    }

    const startedAt = Date.now()
    const { data, error } = await supabase.rpc('reader_library_feed_page', args)
    if (error) throw error

    const rows = Array.isArray(data) ? data : []
    const pageRows = rows.slice(0, PAGE_SIZE)
    const hasMore = rows.length > PAGE_SIZE
    const lastRow = pageRows[pageRows.length - 1]
    const result = {
      ok: true,
      items: pageRows.map(toLibraryItem),
      pagination: {
        limit: PAGE_SIZE,
        has_more: hasMore,
        next_cursor: hasMore ? makeCursor(lastRow, tab, type) : null,
      },
    }

    if (tab === 'subscribed' && !cursor && req.query.include_counts === '1') {
      const { data: countRows, error: countError } = await supabase.rpc(
        'reader_library_unread_counts',
        { p_user_id: userId, p_include_adult: includeAdult }
      )
      if (countError) throw countError
      const counts = { all: 0, novel: 0, manga: 0, chat_story: 0 }
      for (const row of countRows || []) {
        if (Object.prototype.hasOwnProperty.call(counts, row.story_type)) {
          counts[row.story_type] = Math.max(0, Number(row.story_count || 0))
        }
      }
      result.unread_story_counts = counts
    }

    const durationMs = Date.now() - startedAt
    if (durationMs >= 2000) {
      console.warn('[READER_LIBRARY_FEED_SLOW]', JSON.stringify({ tab, type, duration_ms: durationMs }))
    }

    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).json(result)
  } catch (error) {
    console.error('[READER_LIBRARY_FEED_ERROR]', error)
    return res.status(500).json({ ok: false, message: 'Failed to load library feed' })
  }
}
