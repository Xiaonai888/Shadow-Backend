import express from 'express'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'

const router = express.Router()
const PAGE_SIZE = 10
const RETENTION_MS = 365 * 86400000
const DAY_MS = 86400000
const CATEGORIES = new Set(['all', 'interactions', 'reading', 'transactions', 'security'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const cambodiaDayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Phnom_Penh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function detailedStart(now) {
  const values = Object.fromEntries(
    cambodiaDayFormatter.formatToParts(now).map((part) => [part.type, part.value])
  )
  return new Date(Date.parse(`${values.year}-${values.month}-${values.day}T00:00:00+07:00`) - 6 * DAY_MS)
}

function encodeCursor(state) {
  return Buffer.from(JSON.stringify(state)).toString('base64url')
}

function parseCursor(raw, category, now) {
  if (!raw) return null
  if (typeof raw !== 'string' || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) return false
  try {
    const state = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (!state || state.category !== category || !['events', 'archive', 'summaries'].includes(state.phase)) return false
    const asOf = Date.parse(state.asOf)
    if (!Number.isFinite(asOf) || asOf > now + 60000 || asOf < now - DAY_MS) return false
    const start = detailedStart(new Date(asOf)).toISOString()
    if (state.start !== start) return false
    if (state.after !== null) {
      if (!state.after || typeof state.after !== 'object') return false
      if (!UUID_PATTERN.test(state.after.id || '')) return false
      const time = Date.parse(state.after.time)
      if (!Number.isFinite(time) || time > asOf || time < now - RETENTION_MS - DAY_MS) return false
    }
    if (state.phase === 'events' && state.after === null) return false
    return { ...state, phase: state.phase === 'summaries' ? 'archive' : state.phase }
  } catch {
    return false
  }
}

function olderThan(query, column, after) {
  if (!after) return query
  const time = new Date(after.time).toISOString()
  return query.or(`${column}.lt.${time},and(${column}.eq.${time},id.lt.${after.id})`)
}

function rowCursor(item) {
  return {
    time: new Date(item.is_summary ? item.period_start : item.occurred_at).toISOString(),
    id: item.id,
  }
}

async function readEvents(userId, category, state, limit, retentionStart) {
  let query = supabase
    .from('reader_activity_events')
    .select('id,category,action,description,occurred_at,created_at')
    .eq('user_id', userId)
    .gte('occurred_at', state.start)
    .gte('occurred_at', retentionStart)
    .lte('occurred_at', state.asOf)
    .order('occurred_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1)
  if (category !== 'all') query = query.eq('category', category)
  query = olderThan(query, 'occurred_at', state.after)
  const { data, error } = await query
  if (error) throw error
  const rows = data || []
  return {
    items: rows.slice(0, limit).map((row) => ({ ...row, period: 'day', is_summary: false })),
    hasMore: rows.length > limit,
  }
}

async function readArchive(userId, category, state, limit, retentionStart) {
  const requests = []

  if (category !== 'security') {
    let query = supabase
      .from('reader_activity_summaries')
      .select('id,category,action,period,period_start,event_count,first_at,last_at')
      .eq('user_id', userId)
      .gte('last_at', retentionStart)
      .lt('period_start', state.start)
      .lte('period_start', state.asOf)
      .order('period_start', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)
    if (category !== 'all') query = query.eq('category', category)
    requests.push(olderThan(query, 'period_start', state.after))
  }

  {
    let query = supabase
      .from('reader_activity_events')
      .select('id,category,action,description,occurred_at,created_at')
      .eq('user_id', userId)
      .gte('occurred_at', retentionStart)
      .lt('occurred_at', state.start)
      .lte('occurred_at', state.asOf)
      .order('occurred_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)
    if (category !== 'all') query = query.eq('category', category)
    requests.push(olderThan(query, 'occurred_at', state.after))
  }

  const results = await Promise.all(requests)
  const items = []
  for (const { data, error } of results) {
    if (error) throw error
    for (const row of data || []) {
      if (row.event_count != null) {
        items.push({
          id: row.id,
          category: row.category,
          action: row.action,
          period: row.period,
          period_start: row.period_start,
          occurred_at: row.last_at,
          first_at: row.first_at,
          count: row.event_count,
          is_summary: true,
        })
      } else {
        items.push({ ...row, period: 'day', is_summary: false })
      }
    }
  }

  items.sort((left, right) => {
    const a = rowCursor(left)
    const b = rowCursor(right)
    if (a.time !== b.time) return a.time > b.time ? -1 : 1
    if (a.id === b.id) return 0
    return a.id > b.id ? -1 : 1
  })

  return { items: items.slice(0, limit), hasMore: items.length > limit }
}

router.get('/', requireUser, createRateLimit({
  key: 'reader-activity-history',
  windowMs: 60000,
  max: 60,
  identity: (req) => req.user?.user_id,
}), async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const category = String(req.query.category || 'all').trim().toLowerCase()
  if (!CATEGORIES.has(category)) {
    return res.status(400).json({ ok: false, message: 'Invalid activity category' })
  }

  const requestedLimit = req.query.limit === undefined ? PAGE_SIZE : Number(req.query.limit)
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > PAGE_SIZE) {
    return res.status(400).json({ ok: false, message: 'Invalid page size' })
  }

  const now = Date.now()
  const cursor = parseCursor(req.query.cursor, category, now)
  if (cursor === false) {
    return res.status(400).json({ ok: false, message: 'Invalid activity cursor' })
  }

  const state = cursor || {
    phase: 'events',
    category,
    asOf: new Date(now).toISOString(),
    start: detailedStart(new Date(now)).toISOString(),
    after: null,
  }
  const retentionStart = new Date(now - RETENTION_MS).toISOString()

  try {
    const userId = req.user.user_id
    let items = []
    let nextCursor = null

    if (state.phase === 'events') {
      const results = await readEvents(userId, category, state, requestedLimit, retentionStart)
      items = results.items
      if (results.hasMore) {
        nextCursor = encodeCursor({ ...state, after: rowCursor(items[items.length - 1]) })
      } else if (items.length === requestedLimit) {
        nextCursor = encodeCursor({ ...state, phase: 'archive', after: null })
      }
    }

    if (!nextCursor && items.length < requestedLimit) {
      const archiveState = state.phase === 'archive'
        ? state
        : { ...state, phase: 'archive', after: null }
      const results = await readArchive(
        userId, category, archiveState, requestedLimit - items.length, retentionStart
      )
      items = [...items, ...results.items]
      if (results.hasMore) {
        nextCursor = encodeCursor({
          ...archiveState,
          after: rowCursor(results.items[results.items.length - 1]),
        })
      }
    }

    return res.status(200).json({ ok: true, items, next_cursor: nextCursor })
  } catch (error) {
    console.error('READER_ACTIVITY_HISTORY_READ_ERROR:', error)
    return res.status(503).json({ ok: false, message: 'Activity history is temporarily unavailable' })
  }
})

export default router
