import { isIP } from 'node:net'
import { supabase } from '../config/supabase.js'

function toPositiveInt(value, fallback, max) {
  const number = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(number, max)
}

function getMonthStartIso() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
}

function getDayStartIso() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
}

function getActiveStartIso() {
  return new Date(Date.now() - 10 * 60 * 1000).toISOString()
}

function cleanSearch(value) {
  return String(value || '').trim().replace(/[%_,()]/g, ' ')
}

async function getOverviewData() {
  const monthStart = getMonthStartIso()

  const [readersResult, authorsResult, newReadersResult] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }),
    supabase.from('author_pages').select('id', { count: 'exact', head: true }),
    supabase.from('users').select('id', { count: 'exact', head: true }).gte('created_at', monthStart),
  ])

  if (readersResult.error) throw readersResult.error
  if (authorsResult.error) throw authorsResult.error
  if (newReadersResult.error) throw newReadersResult.error

  const totalReaders = readersResult.count || 0
  const totalAuthors = authorsResult.count || 0
  const newReaders = newReadersResult.count || 0

  return {
    total_readers: totalReaders,
    total_authors: totalAuthors,
    total_community_members: totalReaders,
    new_this_month: newReaders,
  }
}

function formatReader(user) {
  return {
    id: user.id,
    name: user.name || user.username || 'Reader',
    username: user.username || '',
    email: user.email || '',
    avatar_url: user.avatar_url || '',
    date_of_birth: user.date_of_birth || null,
    gender: user.gender || '',
    custom_gender: user.custom_gender || '',
    status: user.is_active === false ? 'inactive' : 'active',
    is_author: Boolean(user.is_author),
    joined_at: user.created_at,
    
  }
}

function formatAuthor(page, userMap, storyCountMap) {
  const user = userMap.get(page.user_id) || {}

  return {
    id: page.id,
    user_id: page.user_id,
    author_name: page.page_name || user.name || 'Author',
    username: page.page_username || page.page_slug || user.username || '',
    email: user.email || '',
    avatar_url: page.avatar_url || user.avatar_url || '',
    books_count: storyCountMap.get(page.id) || 0,
    status: page.status || (user.is_active === false ? 'inactive' : 'active'),
    joined_at: page.created_at,
    updated_at: page.updated_at,
  }
}

function formatVisitor(visitor) {
  return {
    id: visitor.id,
    visitor_id: visitor.visitor_id || '',
    session_id: visitor.session_id || '',
    ip_address: visitor.ip_address || '',
    device_type: visitor.device_type || 'Unknown',
    browser: visitor.browser || 'Unknown',
    operating_system: visitor.operating_system || 'Unknown',
    country_code: visitor.country_code || '',
    cf_ray: visitor.cf_ray || '',
    is_suspected_bot: Boolean(visitor.is_suspected_bot),
    bot_reason: visitor.bot_reason || '',
    bot_score: Number(visitor.bot_score || 0),
    risk_level: visitor.risk_level || 'normal',
    bot_signals: Array.isArray(visitor.bot_signals) ? visitor.bot_signals : [],
    webdriver_detected: Boolean(visitor.webdriver_detected),
    event_count: Number(visitor.event_count || 0),
    rapid_repeat_count: Number(visitor.rapid_repeat_count || 0),
    last_event_at: visitor.last_event_at,
    page_views: Number(visitor.page_views || 0),
    first_path: visitor.first_path || '/',
    last_path: visitor.last_path || '/',
    referrer: visitor.referrer || '',
    user_agent: visitor.user_agent || '',
    first_seen_at: visitor.first_seen_at,
    last_seen_at: visitor.last_seen_at,
    created_at: visitor.created_at,
    updated_at: visitor.updated_at,
  }
}

async function countVisitorRows(column, value) {
  const { count, error } = await supabase
    .from('anonymous_visitor_sessions')
    .select('id', { count: 'exact', head: true })
    .eq(column, value)

  if (error) throw error
  return count || 0
}

export async function getAdminCommunityOverview(req, res) {
  try {
    const summary = await getOverviewData()

    return res.status(200).json({
      ok: true,
      summary,
    })
  } catch (error) {
    console.error('ADMIN COMMUNITY OVERVIEW ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load community overview', error: error.message })
  }
}

export async function getAdminCommunityReaders(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 100)
    const q = cleanSearch(req.query.q)
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('users')
      .select('id, name, username, email, avatar_url, date_of_birth, gender, custom_gender, is_active, is_author, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (q) {
      query = query.or(`name.ilike.%${q}%,username.ilike.%${q}%,email.ilike.%${q}%`)
    }

    const { data, error, count } = await query

if (error) throw error

let genderQuery = supabase
  .from('users')
  .select('gender, custom_gender')

if (q) {
  genderQuery = genderQuery.or(`name.ilike.%${q}%,username.ilike.%${q}%,email.ilike.%${q}%`)
}

const { data: genderRows, error: genderError } = await genderQuery

if (genderError) throw genderError

const genderSummary = (genderRows || []).reduce(
  (summary, user) => {
    const gender = String(user.gender || '').toLowerCase()

    if (gender === 'female') summary.female += 1
    else if (gender === 'male') summary.male += 1
    else if (gender === 'custom') summary.custom += 1
    else summary.not_provided += 1

    summary.total += 1
    return summary
  },
  { total: 0, female: 0, male: 0, custom: 0, not_provided: 0 }
)

const total = count || 0
const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      readers: (data || []).map(formatReader),
gender_summary: genderSummary,
page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('ADMIN COMMUNITY READERS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load readers', error: error.message })
  }
}

export async function getAdminCommunityAuthors(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 100)
    const q = cleanSearch(req.query.q)
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('author_pages')
      .select('id, user_id, page_name, page_username, page_slug, avatar_url, status, created_at, updated_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (q) {
      query = query.or(`page_name.ilike.%${q}%,page_username.ilike.%${q}%,page_slug.ilike.%${q}%`)
    }

    const { data, error, count } = await query

    if (error) throw error

    const authorPages = data || []
    const userIds = [...new Set(authorPages.map((pageItem) => pageItem.user_id).filter(Boolean))]
    const authorIds = authorPages.map((pageItem) => pageItem.id).filter(Boolean)
    const userMap = new Map()
    const storyCountMap = new Map()

    if (userIds.length) {
      const { data: users, error: usersError } = await supabase
        .from('users')
        .select('id, name, username, email, avatar_url, is_active')
        .in('id', userIds)

      if (usersError) throw usersError

      ;(users || []).forEach((user) => {
        userMap.set(user.id, user)
      })
    }

    if (authorIds.length) {
      const { data: stories, error: storiesError } = await supabase
        .from('stories')
        .select('id, author_id')
        .in('author_id', authorIds)

      if (!storiesError) {
        ;(stories || []).forEach((story) => {
          storyCountMap.set(story.author_id, (storyCountMap.get(story.author_id) || 0) + 1)
        })
      }
    }

    const total = count || 0
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      authors: authorPages.map((pageItem) => formatAuthor(pageItem, userMap, storyCountMap)),
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('ADMIN COMMUNITY AUTHORS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load authors', error: error.message })
  }
}

export async function getAdminCommunityVisitorOverview(req, res) {
  try {
    const { data: overviewRows, error: overviewError } = await supabase.rpc('get_anonymous_visitor_overview')

    if (overviewError) throw overviewError

    const overview = Array.isArray(overviewRows) ? overviewRows[0] || {} : overviewRows || {}

    const [
      suspectedBots,
      normalRisk,
      lowRisk,
      suspiciousRisk,
      likelyBotRisk,
      highRisk,
    ] = await Promise.all([
      countVisitorRows('is_suspected_bot', true),
      countVisitorRows('risk_level', 'normal'),
      countVisitorRows('risk_level', 'low_risk'),
      countVisitorRows('risk_level', 'suspicious'),
      countVisitorRows('risk_level', 'likely_bot'),
      countVisitorRows('risk_level', 'high_risk'),
    ])

    return res.status(200).json({
      ok: true,
      summary: {
        total_unique_visitors: Number(overview.total_unique_visitors || 0),
        total_sessions: Number(overview.total_sessions || 0),
        visitors_today: Number(overview.visitors_today || 0),
        visitors_this_month: Number(overview.visitors_this_month || 0),
        active_last_10_minutes: Number(overview.active_last_10_minutes || 0),
        total_page_views: Number(overview.total_page_views || 0),
        suspected_bots: suspectedBots,
        normal_risk: normalRisk,
        low_risk: lowRisk,
        suspicious_risk: suspiciousRisk,
        likely_bot_risk: likelyBotRisk,
        high_risk: highRisk,
      },
    })
  } catch (error) {
    console.error('ADMIN COMMUNITY VISITOR OVERVIEW ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load visitor overview',
      error: error.message,
    })
  }
}

export async function getAdminCommunityVisitors(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 100)
    const q = cleanSearch(req.query.q)
    const filter = String(req.query.filter || 'all').trim().toLowerCase()
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('anonymous_visitor_sessions')
      .select(
        'id, visitor_id, session_id, ip_address, device_type, browser, operating_system, country_code, cf_ray, is_suspected_bot, bot_reason, bot_score, risk_level, bot_signals, webdriver_detected, event_count, rapid_repeat_count, last_event_at, page_views, first_path, last_path, referrer, user_agent, first_seen_at, last_seen_at, created_at, updated_at',
        { count: 'exact' }
      )
      .order('last_seen_at', { ascending: false })
      .range(from, to)

    if (q) {
      if (isIP(q)) {
        query = query.eq('ip_address', q)
      } else {
        query = query.or(
          `visitor_id.ilike.%${q}%,session_id.ilike.%${q}%,device_type.ilike.%${q}%,browser.ilike.%${q}%,operating_system.ilike.%${q}%,country_code.ilike.%${q}%,cf_ray.ilike.%${q}%,risk_level.ilike.%${q}%,bot_reason.ilike.%${q}%`
        )
      }
    }

    if (filter === 'active') {
      query = query.gte('last_seen_at', getActiveStartIso())
    } else if (filter === 'today') {
      query = query.gte('first_seen_at', getDayStartIso())
    } else if (filter === 'bots') {
      query = query.eq('is_suspected_bot', true)
    } else if (filter === 'humans') {
      query = query.eq('is_suspected_bot', false)
    } else if (filter === 'normal') {
      query = query.eq('risk_level', 'normal')
    } else if (filter === 'low_risk') {
      query = query.eq('risk_level', 'low_risk')
    } else if (filter === 'suspicious') {
      query = query.eq('risk_level', 'suspicious')
    } else if (filter === 'likely_bot') {
      query = query.eq('risk_level', 'likely_bot')
    } else if (filter === 'high_risk') {
      query = query.eq('risk_level', 'high_risk')
    }

    const { data, error, count } = await query

    if (error) throw error

    const total = count || 0
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      visitors: (data || []).map(formatVisitor),
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('ADMIN COMMUNITY VISITORS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load visitors',
      error: error.message,
    })
  }
}
