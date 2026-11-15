import { supabase } from '../config/supabase.js'

const AUDIENCES = new Set(['khmer', 'international'])
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_LIMIT = 30
const MAX_LIMIT = 50
const MAX_DAYS = 90

function dateInCambodia(date = new Date()) {
  const items = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const field = (name) => items.find((item) => item.type === name)?.value
  return `${field('year')}-${field('month')}-${field('day')}`
}

function dateValue(value) {
  const text = String(value || '')
  if (!DATE_PATTERN.test(text)) return null
  const parsed = Date.parse(`${text}T00:00:00Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === text
    ? parsed : null
}

function shiftDay(day, delta) {
  return new Date(dateValue(day) + delta * 86400000).toISOString().slice(0, 10)
}

function integer(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : fallback
}

function validateFilter(query = {}) {
  const audience = String(query.audience || 'khmer').toLowerCase()
  if (!AUDIENCES.has(audience)) {
    const error = new Error('Invalid Task Center audience')
    error.status = 400
    throw error
  }
  const now = dateInCambodia()
  const defaultDay = shiftDay(now, -1)
  const start = String(query.start || defaultDay)
  const end = String(query.end || defaultDay)
  const first = dateValue(start)
  const last = dateValue(end)
  if (first === null || last === null || last < first || last > dateValue(now) ||
      (last - first) / 86400000 >= MAX_DAYS) {
    const error = new Error('Select a valid date range of up to 90 days, not beyond today in Cambodia')
    error.status = 400
    throw error
  }
  return {
    audience, start, end,
    page: integer(query.page, 1, 1, 100000),
    limit: integer(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
  }
}

async function storyTitleMap(rows) {
  const ids = [...new Set(rows.map((row) => String(row.story_id || '')))]
    .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || /^\d+$/.test(id))
  if (ids.length === 0) return new Map()
  const titles = new Map()
  for (let start = 0; start < ids.length; start += 30) {
    const { data, error } = await supabase
      .from('stories')
      .select('id, title')
      .in('id', ids.slice(start, start + 30))
      .limit(30)
    if (error) throw error
    for (const story of data || []) titles.set(String(story.id), story.title)
  }
  return titles
}

export async function getTaskCenterSelectionHistory(query = {}) {
  const filter = validateFilter(query)
  const offset = (filter.page - 1) * filter.limit
  const { data, error, count } = await supabase
    .from('task_center_selection_history_view')
    .select('id, audience, selection_date, selected_at, mission_id, slot, story_id, story_link, story_title, selection_mode, selection_reason, auto_source, previous_selection_date, is_repeat', { count: 'exact' })
    .eq('audience', filter.audience)
    .gte('selection_date', filter.start)
    .lte('selection_date', filter.end)
    .order('selection_date', { ascending: false })
    .order('selected_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + filter.limit - 1)

  if (error) throw error
  const rows = data || []
  const titles = await storyTitleMap(rows)
  const entries = rows.map((row) => ({
    ...row,
    story_title: titles.get(String(row.story_id)) || row.story_title || `Story ${row.story_id}`,
  }))
  const total = Number(count || 0)
  return {
    audience: filter.audience,
    start: filter.start,
    end: filter.end,
    timezone: 'Asia/Phnom_Penh',
    entries,
    pagination: {
      page: filter.page,
      limit: filter.limit,
      total,
      has_more: offset + rows.length < total,
    },
  }
}
