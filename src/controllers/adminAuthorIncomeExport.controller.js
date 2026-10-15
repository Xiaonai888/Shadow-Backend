import { supabase } from '../config/supabase.js'

const DETAIL_MAX_ROWS = 500
const DETAIL_MAX_DAYS = 31
const KHMER_OFFSET_MS = 7 * 60 * 60 * 1000
const ALLOWED_PERIODS = new Set(['today', 'week', 'month', 'year', 'custom', 'all'])
const ALLOWED_STATUSES = new Set(['all', 'pending', 'available', 'paid', 'unknown'])

function text(value, limit = 80) {
  return String(value ?? '').trim().slice(0, limit)
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function fail(message, status = 400) {
  const error = new Error(message)
  error.status = status
  throw error
}

function cambodiaDate(date) {
  return new Date(date.getTime() + KHMER_OFFSET_MS).toISOString().slice(0, 10)
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function parseBoundary(value, endExclusive = false) {
  const input = text(value, 64)
  if (!input) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const date = new Date(`${input}T00:00:00+07:00`)
    if (!Number.isFinite(date.getTime()) || cambodiaDate(date) !== input) fail('Invalid date')
    return new Date(date.getTime() + (endExclusive ? 86400000 : 0)).toISOString()
  }
  const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(input)
  const absolute = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(input)
  if (!local && !absolute) fail('Invalid date or time format')
  const date = new Date(local ? `${input}+07:00` : input)
  if (!Number.isFinite(date.getTime()) || (local && cambodiaDate(date) !== input.slice(0, 10))) fail('Invalid date or time')
  return date.toISOString()
}

function getRange(query) {
  const rawPeriod = text(query.period, 16).toLowerCase()
  const period = rawPeriod || (query.from || query.to ? 'custom' : 'month')
  if (!ALLOWED_PERIODS.has(period)) fail('Invalid time period')
  const today = cambodiaDate(new Date())
  const firstOfMonth = `${today.slice(0, 7)}-01`
  const firstOfYear = `${today.slice(0, 4)}-01-01`
  let fromDate = null
  let toDate = null
  if (period === 'today') {
    fromDate = today
    toDate = shiftDate(today, 1)
  } else if (period === 'week') {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay()
    fromDate = shiftDate(today, -((weekday + 6) % 7))
    toDate = shiftDate(today, 1)
  } else if (period === 'month') {
    fromDate = firstOfMonth
    toDate = shiftDate(today, 1)
  } else if (period === 'year') {
    fromDate = firstOfYear
    toDate = shiftDate(today, 1)
  } else if (period === 'custom' && (!query.from || !query.to)) {
    fail('Custom range needs both start and end dates')
  }
  const from = period === 'custom' ? parseBoundary(query.from) : fromDate ? parseBoundary(fromDate) : null
  const to = period === 'custom' ? parseBoundary(query.to, true) : toDate ? parseBoundary(toDate) : null
  if (from && to && Date.parse(from) >= Date.parse(to)) fail('Start date must be earlier than end date')
  const days = from && to ? (Date.parse(to) - Date.parse(from)) / 86400000 : null
  const summary = period === 'all' || period === 'year' || (days !== null && days > DETAIL_MAX_DAYS)
  return { period, from, to, days, mode: summary ? 'summary' : 'detail' }
}

function getFilters(query) {
  const status = text(query.status, 24).toLowerCase() || 'all'
  if (!ALLOWED_STATUSES.has(status)) fail('Invalid earning status')
  return { status, shareSource: text(query.share_source, 64).toLowerCase() }
}

function makeEarningsQuery(authorId, range, filters, countOnly = false) {
  const fields = countOnly ? 'id' : [
    'id', 'reader_id', 'story_id', 'episode_id', 'unlock_transaction_id',
    'paid_diamonds', 'net_paid_diamonds', 'author_earned_diamonds',
    'platform_earned_diamonds', 'author_share_percent', 'share_source',
    'diamond_to_usd_rate', 'author_gross_usd', 'author_net_payout_usd',
    'withholding_percent', 'withholding_amount_usd', 'earning_status',
    'available_at', 'metadata', 'created_at',
  ].join(',')
  let query = supabase.from('author_earnings')
    .select(fields, countOnly ? { count: 'exact', head: true } : undefined)
    .eq('currency', 'diamond')
    .or('earning_status.is.null,earning_status.neq.void')
    .or(`author_id.eq.${authorId},author_user_id.eq.${authorId}`)
  if (range.from) query = query.gte('created_at', range.from)
  if (range.to) query = query.lt('created_at', range.to)
  if (filters.shareSource) query = query.eq('share_source', filters.shareSource)
  if (filters.status === 'unknown') {
    query = query.or('earning_status.is.null,earning_status.eq.unknown')
  } else if (filters.status !== 'all') {
    query = query.eq('earning_status', filters.status)
  }
  return query
}

async function loadSummary(authorId, range, filters, bucket) {
  const { data, error } = await supabase.rpc('get_admin_author_income_export_summary', {
    p_author_id: authorId,
    p_from: range.from,
    p_to: range.to,
    p_bucket: bucket,
    p_status: filters.status,
    p_share_source: filters.shareSource || null,
  })
  if (error) throw error
  if (!data || !Array.isArray(data.rows) || !data.totals) fail('Invalid income summary response', 502)
  return data
}

function metadataObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function value(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function money(value) {
  return Number(value.toFixed(2))
}

async function findMapped(table, columns, ids) {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return new Map()
  const map = new Map()
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await supabase.from(table)
      .select(columns).in('id', unique.slice(i, i + 100))
    if (error) throw error
    for (const row of data || []) map.set(String(row.id), row)
  }
  return map
}

async function getAuthor(authorId) {
  const [pages, users] = await Promise.all([
    supabase.from('author_pages').select('id,user_id,page_name,page_username')
      .or(`id.eq.${authorId},user_id.eq.${authorId}`).limit(1),
    supabase.from('users').select('id,name,username').eq('id', authorId).limit(1),
  ])
  if (pages.error) throw pages.error
  if (users.error) throw users.error
  const page = pages.data?.[0] || null
  const user = users.data?.[0] || null
  return {
    id: authorId,
    name: page?.page_name || user?.name || '',
    username: page?.page_username || user?.username || '',
  }
}

async function loadDetails(authorId, range, filters) {
  const countResult = await makeEarningsQuery(authorId, range, filters, true)
  if (countResult.error) throw countResult.error
  const total = Number(countResult.count || 0)
  if (total > DETAIL_MAX_ROWS) {
    fail(`This period has ${total} transactions. Please select a shorter Custom range (maximum ${DETAIL_MAX_ROWS} detailed rows).`, 413)
  }
  if (!total) return []
  const result = await makeEarningsQuery(authorId, range, filters)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, DETAIL_MAX_ROWS - 1)
  if (result.error) throw result.error
  const rows = result.data || []
  if (rows.length > DETAIL_MAX_ROWS) fail('Export is too large', 413)
  const [readers, stories, episodes] = await Promise.all([
    findMapped('users', 'id,name,username,email', rows.map(row => row.reader_id)),
    findMapped('stories', 'id,title', rows.map(row => row.story_id)),
    findMapped('episodes', 'id,title,episode_number', rows.map(row => row.episode_id)),
  ])
  return rows.map(row => {
    const metadata = metadataObject(row.metadata)
    const reader = readers.get(String(row.reader_id))
    const story = stories.get(String(row.story_id))
    const episode = episodes.get(String(row.episode_id))
    const rate = value(row.diamond_to_usd_rate) || 0.01
    return {
      id: row.id,
      created_at: row.created_at,
      available_at: row.available_at,
      status: row.earning_status || 'unknown',
      reader_name: reader?.name || metadata.reader_name || '',
      reader_username: reader?.username || metadata.reader_username || '',
      reader_email: reader?.email || '',
      story_title: story?.title || metadata.story_title || '',
      episode_number: value(episode?.episode_number ?? metadata.episode_number),
      episode_title: episode?.title || metadata.episode_title || '',
      paid_diamonds: value(row.paid_diamonds),
      net_paid_diamonds: value(row.net_paid_diamonds),
      author_share_percent: value(row.author_share_percent),
      share_source: row.share_source || '',
      author_earned_diamonds: value(row.author_earned_diamonds),
      platform_earned_diamonds: value(row.platform_earned_diamonds),
      author_earnings_usd: money(value(row.author_earned_diamonds) * rate),
      platform_income_usd: money(value(row.platform_earned_diamonds) * rate),
      author_gross_usd: money(value(row.author_gross_usd)),
      withholding_percent: value(row.withholding_percent),
      withholding_amount_usd: money(value(row.withholding_amount_usd)),
      author_net_payout_usd: money(value(row.author_net_payout_usd)),
      purchase_reference: String(metadata.purchase_key || ''),
      transaction_reference: row.unlock_transaction_id || row.id,
    }
  })
}

export async function getAdminAuthorIncomeExportData(req, res) {
  res.set('Cache-Control', 'private, no-store')
  try {
    const authorId = text(req.params.authorId, 64)
    if (!validUuid(authorId)) fail('Invalid author ID')
    const range = getRange(req.query)
    const filters = getFilters(req.query)
    const bucket = range.period === 'all' ? 'year' : 'month'
    const [author, report] = await Promise.all([
      getAuthor(authorId),
      loadSummary(authorId, range, filters, bucket),
    ])
    if (range.mode === 'summary') {
      let monthlyRows = null
      if (range.period === 'all') {
        const monthly = await loadSummary(authorId, range, filters, 'month')
        monthlyRows = monthly.rows
      }
      return res.status(200).json({
        ok: true,
        author,
        range,
        filters: { status: filters.status, share_source: filters.shareSource },
        mode: 'summary',
        bucket,
        totals: report.totals,
        rows: report.rows,
        ...(monthlyRows ? { monthly_rows: monthlyRows } : {}),
      })
    }
    const rows = await loadDetails(authorId, range, filters)
    return res.status(200).json({
      ok: true,
      author,
      range,
      filters: { status: filters.status, share_source: filters.shareSource },
      mode: 'detail',
      totals: report.totals,
      rows,
    })
  } catch (error) {
    if (!error.status || error.status >= 500) {
      console.error('ADMIN AUTHOR INCOME EXPORT DATA ERROR:', error)
    }
    return res.status(error.status || 500).json({
      ok: false,
      message: error.status ? error.message : 'Failed to prepare author income report',
    })
  }
}
