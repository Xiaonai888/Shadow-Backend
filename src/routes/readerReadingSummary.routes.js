import express from 'express'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'

const router = express.Router()
const PAGE_SIZE = 10
const RETENTION_DAYS = 365
const DAY_MS = 86400000
const totalsCache = new Map()
const dayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Phnom_Penh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function cambodiaToday() {
  const parts = Object.fromEntries(dayFormatter.formatToParts(new Date()).map(({ type, value }) => [type, value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function daysBefore(day, count) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - count * DAY_MS).toISOString().slice(0, 10)
}

function validCursor(value, firstDay, today) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= firstDay && value < today
}

async function getTotals(userId, firstDay, today) {
  const cache = totalsCache.get(userId)
  if (cache?.day === today && Date.now() - cache.savedAt < 30 * 60 * 1000) return cache.totals
  const { data, error } = await supabase
    .from('reader_reading_daily_summaries')
    .select('stories_read,episodes_read')
    .eq('user_id', userId)
    .gte('day', firstDay)
    .lt('day', today)
    .limit(RETENTION_DAYS + 1)
  if (error) throw error
  const totals = (data || []).reduce((result, row) => ({
    stories_read: result.stories_read + (Number(row.stories_read) || 0),
    episodes_read: result.episodes_read + (Number(row.episodes_read) || 0),
  }), { stories_read: 0, episodes_read: 0 })
  totalsCache.set(userId, { day: today, totals, savedAt: Date.now() })
  if (totalsCache.size > 1000) totalsCache.delete(totalsCache.keys().next().value)
  return totals
}

router.get('/', requireUser, createRateLimit({
  key: 'reader-reading-summary',
  windowMs: 60000,
  max: 60,
  identity: (req) => req.user?.user_id,
}), async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  const limit = req.query.limit === undefined ? PAGE_SIZE : Number(req.query.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE) {
    return res.status(400).json({ ok: false, message: 'Invalid page size' })
  }

  const today = cambodiaToday()
  const firstDay = daysBefore(today, RETENTION_DAYS)
  const cursor = req.query.cursor
  if (cursor !== undefined && !validCursor(cursor, firstDay, today)) {
    return res.status(400).json({ ok: false, message: 'Invalid summary cursor' })
  }

  try {
    const userId = req.user.user_id
    let query = supabase
      .from('reader_reading_daily_summaries')
      .select('day,stories_read,episodes_read')
      .eq('user_id', userId)
      .gte('day', firstDay)
      .lt('day', today)
      .order('day', { ascending: false })
      .limit(limit + 1)
    if (cursor) query = query.lt('day', cursor)
    const { data, error } = await query
    if (error) throw error

    const rows = data || []
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => ({
      date: row.day,
      stories_read: Math.max(0, Number(row.stories_read) || 0),
      episodes_read: Math.max(0, Number(row.episodes_read) || 0),
    }))
    const totals = cursor === undefined ? await getTotals(userId, firstDay, today) : null
    const nextCursor = hasMore ? items[items.length - 1].date : null

    return res.status(200).json({ ok: true, items, totals, next_cursor: nextCursor })
  } catch (error) {
    console.error('READER_READING_SUMMARY_ERROR:', error)
    return res.status(503).json({ ok: false, message: 'Reading summary is temporarily unavailable' })
  }
})

export default router
