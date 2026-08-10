import { isIP } from 'node:net'
import { supabase } from '../config/supabase.js'

const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const PAGE_SIZE = 1000

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

function getCambodiaDayRange(now = new Date()) {
  const cambodiaNow = new Date(now.getTime() + CAMBODIA_OFFSET_MS)
  const startTime =
    Date.UTC(
      cambodiaNow.getUTCFullYear(),
      cambodiaNow.getUTCMonth(),
      cambodiaNow.getUTCDate()
    ) - CAMBODIA_OFFSET_MS

  return {
    startIso: new Date(startTime).toISOString(),
    endIso: new Date(startTime + DAY_MS).toISOString(),
    nowIso: now.toISOString(),
  }
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

async function getReaderActivityToday() {
  const { startIso, nowIso } = getCambodiaDayRange()
  const activeStartIso = getActiveStartIso()
  const rows = []
  let from = 0

  while (true) {
    const { data, error } = await supabase
      .from('reading_progress')
      .select('user_id, last_read_at')
      .gte('last_read_at', startIso)
      .lte('last_read_at', nowIso)
      .order('last_read_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)

    if (error) throw error

    const pageRows = Array.isArray(data) ? data : []
    rows.push(...pageRows)

    if (pageRows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  const readersToday = new Set()
  const activeReaders = new Set()

  for (const row of rows) {
    const userId = String(row.user_id || '').trim()
    if (!userId) continue

    readersToday.add(userId)

    if (row.last_read_at && row.last_read_at >= activeStartIso) {
      activeReaders.add(userId)
    }
  }

  return {
    readers_today: readersToday.size,
    active_readers_last_10_minutes: activeReaders.size,
  }
}

async function getPublishedEpisodeRowsToday() {
  const { startIso, endIso, nowIso } = getCambodiaDayRange()
  const effectiveEndIso = nowIso < endIso ? nowIso : endIso
  const rows = []

  for (const mode of ['scheduled', 'legacy']) {
    let from = 0

    while (true) {
      let query = supabase
        .from('episodes')
        .select('id, story_id, published_at, created_at')
        .eq('status', 'published')
        .is('deleted_at', null)
        .order(mode === 'scheduled' ? 'published_at' : 'created_at', { ascending: true })
        .range(from, from + PAGE_SIZE - 1)

      if (mode === 'scheduled') {
        query = query
          .not('published_at', 'is', null)
          .gte('published_at', startIso)
          .lte('published_at', effectiveEndIso)
      } else {
        query = query
          .is('published_at', null)
          .gte('created_at', startIso)
          .lte('created_at', effectiveEndIso)
      }

      const { data, error } = await query

      if (error) throw error

      const pageRows = Array.isArray(data) ? data : []
      rows.push(...pageRows)

      if (pageRows.length < PAGE_SIZE) break
      from += PAGE_SIZE
    }
  }

  return rows
}

async function getStoryUpdatesToday() {
  const episodeRows = await getPublishedEpisodeRowsToday()
  const episodeById = new Map()

  for (const episode of episodeRows) {
    if (episode?.id) episodeById.set(String(episode.id), episode)
  }

  const uniqueEpisodes = [...episodeById.values()]
  const storyIds = [...new Set(uniqueEpisodes.map((episode) => episode.story_id).filter(Boolean))]

  if (!storyIds.length) {
    return {
      stories_updated_today: 0,
      episodes_published_today: 0,
    }
  }

  const validStoryIds = new Set()

  for (let index = 0; index < storyIds.length; index += PAGE_SIZE) {
    const batch = storyIds.slice(index, index + PAGE_SIZE)
    const { data, error } = await supabase
      .from('stories')
      .select('id')
      .in('id', batch)
      .eq('status', 'published')
      .is('deleted_at', null)

    if (error) throw error

    for (const story of data || []) {
      if (story?.id) validStoryIds.add(String(story.id))
    }
  }

  const publishedEpisodes = uniqueEpisodes.filter((episode) =>
    validStoryIds.has(String(episode.story_id || ''))
  )

  return {
    stories_updated_today: validStoryIds.size,
    episodes_published_today: publishedEpisodes.length,
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

async function getVisitorsTodayCount() {
  const { startIso, nowIso } = getCambodiaDayRange()
  const visitorIds = new Set()
  let from = 0

  while (true) {
    const { data, error } = await supabase
      .from('anonymous_visitor_sessions')
      .select('visitor_id')
      .gte('last_seen_at', startIso)
      .lte('last_seen_at', nowIso)
      .order('last_seen_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)

    if (error) throw error

    const rows = Array.isArray(data) ? data : []

    for (const row of rows) {
      const visitorId = String(row.visitor_id || '').trim()
      if (visitorId) visitorIds.add(visitorId)
    }

    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return visitorIds.size
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
    const requestedFilter = String(req.query.filter || 'all').trim().toLowerCase()
    const filter = [
      'all',
      'new_reader',
      'reader_only',
      'authors',
      'active',
      'inactive',
    ].includes(requestedFilter)
      ? requestedFilter
      : 'all'

    const { data, error } = await supabase.rpc('get_admin_community_readers_v2', {
      p_page: page,
      p_limit: limit,
      p_search: q,
      p_filter: filter,
    })

    if (error) throw error

    return res.status(200).json(
      data || {
        ok: true,
        readers: [],
        gender_summary: {
          total: 0,
          female: 0,
          male: 0,
          custom: 0,
          not_provided: 0,
        },
        page,
        limit,
        total: 0,
        total_pages: 1,
        has_next: false,
        has_prev: false,
      }
    )
  } catch (error) {
    console.error('ADMIN COMMUNITY READERS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load readers',
      error: error.message,
    })
  }
}

function getAgeFromDateOfBirth(value, now = new Date()) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return null

  const birthYear = Number(match[1])
  const birthMonth = Number(match[2])
  const birthDay = Number(match[3])
  const cambodiaNow = new Date(now.getTime() + CAMBODIA_OFFSET_MS)

  let age = cambodiaNow.getUTCFullYear() - birthYear
  const currentMonth = cambodiaNow.getUTCMonth() + 1
  const currentDay = cambodiaNow.getUTCDate()

  if (
    currentMonth < birthMonth ||
    (currentMonth === birthMonth && currentDay < birthDay)
  ) {
    age -= 1
  }

  if (!Number.isFinite(age) || age < 0 || age > 130) return null
  return age
}

function getReaderAgeGroup(age) {
  if (!Number.isFinite(age)) return 'unknown'
  if (age < 13) return 'under_13'
  if (age < 18) return '13_17'
  if (age < 25) return '18_24'
  if (age < 35) return '25_34'
  if (age < 45) return '35_44'
  if (age < 55) return '45_54'
  return '55_plus'
}

export async function getAdminCommunityReadersToday(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 100)
    const q = cleanSearch(req.query.q).toLowerCase()
    const { startIso, nowIso } = getCambodiaDayRange()
    const activeStartIso = getActiveStartIso()
    const progressRows = []
    let from = 0

    while (true) {
      const { data, error } = await supabase
        .from('reading_progress')
        .select('id, user_id, story_id, episode_id, episode_number, total_episodes, reading_percent, last_read_at')
        .gte('last_read_at', startIso)
        .lte('last_read_at', nowIso)
        .order('last_read_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1)

      if (error) throw error

      const rows = Array.isArray(data) ? data : []
      progressRows.push(...rows)

      if (rows.length < PAGE_SIZE) break
      from += PAGE_SIZE
    }

    const latestActivityMap = new Map()

    for (const row of progressRows) {
      const userId = String(row.user_id || '').trim()
      const storyId = String(row.story_id || '').trim()
      if (!userId || !storyId) continue

      const key = `${userId}:${storyId}`
      if (!latestActivityMap.has(key)) {
        latestActivityMap.set(key, row)
      }
    }

    const activities = [...latestActivityMap.values()]
    const userIds = [...new Set(activities.map((row) => row.user_id).filter(Boolean))]
    const storyIds = [...new Set(activities.map((row) => row.story_id).filter(Boolean))]
    const episodeIds = [...new Set(activities.map((row) => row.episode_id).filter(Boolean))]
    const userMap = new Map()
    const storyMap = new Map()
    const episodeMap = new Map()

    for (let index = 0; index < userIds.length; index += 500) {
      const { data, error } = await supabase
        .from('users')
        .select('id, name, username, email, avatar_url, date_of_birth, gender, custom_gender, is_active, is_author, created_at')
        .in('id', userIds.slice(index, index + 500))

      if (error) throw error
      for (const user of data || []) userMap.set(String(user.id), user)
    }

    for (let index = 0; index < storyIds.length; index += 500) {
      const { data, error } = await supabase
        .from('stories')
        .select('id, title, cover_url, story_type, story_language, main_genre, is_adult, status, deleted_at')
        .in('id', storyIds.slice(index, index + 500))

      if (error) throw error
      for (const story of data || []) storyMap.set(String(story.id), story)
    }

    for (let index = 0; index < episodeIds.length; index += 500) {
      const { data, error } = await supabase
        .from('episodes')
        .select('id, story_id, title, episode_number, status, deleted_at')
        .in('id', episodeIds.slice(index, index + 500))

      if (error) throw error
      for (const episode of data || []) episodeMap.set(String(episode.id), episode)
    }

    let items = activities
      .map((row) => {
        const user = userMap.get(String(row.user_id)) || null
        const story = storyMap.get(String(row.story_id)) || null
        const episode = episodeMap.get(String(row.episode_id)) || null

        if (!user || !story) return null

        const age = getAgeFromDateOfBirth(user.date_of_birth)

        return {
          id: row.id,
          last_read_at: row.last_read_at,
          reading_percent: Number(row.reading_percent || 0),
          episode_number: Number(row.episode_number || episode?.episode_number || 0),
          total_episodes: Number(row.total_episodes || 0),
          active_last_10_minutes: Boolean(
            row.last_read_at && row.last_read_at >= activeStartIso
          ),
          reader: {
            id: user.id,
            name: user.name || user.username || 'Reader',
            username: user.username || '',
            email: user.email || '',
            avatar_url: user.avatar_url || '',
            date_of_birth: user.date_of_birth || null,
            age,
            age_group: getReaderAgeGroup(age),
            gender: user.gender || '',
            custom_gender: user.custom_gender || '',
            status: user.is_active === false ? 'inactive' : 'active',
            is_author: Boolean(user.is_author),
            joined_at: user.created_at,
          },
          story: {
            id: story.id,
            title: story.title || 'Untitled story',
            cover_url: story.cover_url || '',
            story_type: story.story_type || '',
            story_language: story.story_language || '',
            main_genre: story.main_genre || '',
            is_adult: Boolean(story.is_adult),
            status: story.status || '',
            deleted_at: story.deleted_at || null,
          },
          episode: episode
            ? {
                id: episode.id,
                title: episode.title || '',
                episode_number: Number(episode.episode_number || row.episode_number || 0),
                status: episode.status || '',
                deleted_at: episode.deleted_at || null,
              }
            : null,
        }
      })
      .filter(Boolean)

    const allItems = items
    const readerIds = new Set(activities.map((row) => String(row.user_id || '')).filter(Boolean))
    const activeReaderIds = new Set(
      activities
        .filter((row) => row.last_read_at && row.last_read_at >= activeStartIso)
        .map((row) => String(row.user_id || ''))
        .filter(Boolean)
    )
    const storiesReadToday = new Set(
      activities.map((row) => String(row.story_id || '')).filter(Boolean)
    )
    const distinctAgeByReader = new Map()

    for (const item of allItems) {
      if (Number.isFinite(item.reader.age) && !distinctAgeByReader.has(item.reader.id)) {
        distinctAgeByReader.set(item.reader.id, item.reader.age)
      }
    }

    const knownAges = [...distinctAgeByReader.values()]
    const averageAge = knownAges.length
      ? Math.round((knownAges.reduce((sum, age) => sum + age, 0) / knownAges.length) * 10) / 10
      : null

    if (q) {
      items = items.filter((item) => {
        const values = [
          item.reader.name,
          item.reader.username,
          item.reader.email,
          item.reader.id,
          item.story.title,
          item.story.id,
          item.episode?.title,
          item.episode?.id,
        ]

        return values.some((value) =>
          String(value || '').toLowerCase().includes(q)
        )
      })
    }

    const total = items.length
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const start = (page - 1) * limit
    const pagedItems = items.slice(start, start + limit)

    return res.status(200).json({
      ok: true,
      summary: {
        readers_today: readerIds.size,
        active_readers_last_10_minutes: activeReaderIds.size,
        stories_read_today: storiesReadToday.size,
        reading_records_today: activities.length,
        age_known_readers: knownAges.length,
        average_reader_age: averageAge,
      },
      items: pagedItems,
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('ADMIN COMMUNITY READERS TODAY ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load readers today',
      error: error.message,
    })
  }
}


export async function getAdminCommunityAuthors(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 100)
    const q = cleanSearch(req.query.q)
    const requestedFilter = String(req.query.filter || 'all').trim().toLowerCase()
    const filter = [
      'all',
      'new_author',
      'active',
      'inactive',
      'with_books',
      'no_books',
    ].includes(requestedFilter)
      ? requestedFilter
      : 'all'

    const { data, error } = await supabase.rpc('get_admin_community_authors_v2', {
      p_page: page,
      p_limit: limit,
      p_search: q,
      p_filter: filter,
    })

    if (error) throw error

    return res.status(200).json(
      data || {
        ok: true,
        authors: [],
        page,
        limit,
        total: 0,
        total_pages: 1,
        has_next: false,
        has_prev: false,
      }
    )
  } catch (error) {
    console.error('ADMIN COMMUNITY AUTHORS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load authors',
      error: error.message,
    })
  }
}

export async function getAdminCommunityVisitorOverview(req, res) {
  try {
    const { data: overviewRows, error: overviewError } = await supabase.rpc('get_anonymous_visitor_overview')

    if (overviewError) throw overviewError

    const overview = Array.isArray(overviewRows) ? overviewRows[0] || {} : overviewRows || {}

    const [
      visitorsToday,
      suspectedBots,
      normalRisk,
      lowRisk,
      suspiciousRisk,
      likelyBotRisk,
      highRisk,
      readerActivity,
      storyUpdates,
    ] = await Promise.all([
      getVisitorsTodayCount(),
      countVisitorRows('is_suspected_bot', true),
      countVisitorRows('risk_level', 'normal'),
      countVisitorRows('risk_level', 'low_risk'),
      countVisitorRows('risk_level', 'suspicious'),
      countVisitorRows('risk_level', 'likely_bot'),
      countVisitorRows('risk_level', 'high_risk'),
      getReaderActivityToday(),
      getStoryUpdatesToday(),
    ])

    return res.status(200).json({
      ok: true,
      summary: {
        total_unique_visitors: Number(overview.total_unique_visitors || 0),
        total_sessions: Number(overview.total_sessions || 0),
        visitors_today: Number(visitorsToday || 0),
        visitors_this_month: Number(overview.visitors_this_month || 0),
        active_last_10_minutes: Number(overview.active_last_10_minutes || 0),
        total_page_views: Number(overview.total_page_views || 0),
        readers_today: Number(readerActivity.readers_today || 0),
        active_readers_last_10_minutes: Number(readerActivity.active_readers_last_10_minutes || 0),
        stories_updated_today: Number(storyUpdates.stories_updated_today || 0),
        episodes_published_today: Number(storyUpdates.episodes_published_today || 0),
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
    const { startIso, nowIso } = getCambodiaDayRange()
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
      query = query
        .gte('last_seen_at', startIso)
        .lte('last_seen_at', nowIso)
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

export async function getAdminReaderPresence(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 100)
    const q = cleanSearch(req.query.q)
    const requestedStatus = String(req.query.status || 'all').trim().toLowerCase()
    const requestedSort = String(req.query.sort || 'last_active').trim().toLowerCase()
    const status = ['all', 'online', 'idle', 'offline'].includes(requestedStatus)
      ? requestedStatus
      : 'all'
    const sort = [
      'last_active',
      'online_longest',
      'most_stories',
      'most_stories_today',
      'name',
    ].includes(requestedSort)
      ? requestedSort
      : 'last_active'

    const { data, error } = await supabase.rpc('get_admin_reader_presence', {
      p_page: page,
      p_limit: limit,
      p_search: q,
      p_status: status,
      p_sort: sort,
    })

    if (error) throw error

    return res.status(200).json(
      data || {
        ok: true,
        summary: {
          total_readers: 0,
          online: 0,
          idle: 0,
          offline: 0,
          average_session_minutes: 0,
        },
        items: [],
        page,
        limit,
        total: 0,
        total_pages: 1,
        has_prev: false,
        has_next: false,
      }
    )
  } catch (error) {
    console.error('ADMIN READER PRESENCE ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load reader presence',
      error: error.message,
    })
  }
}


const DASHBOARD_MALL_PAID_STATUSES = [
  'under_review',
  'confirmed',
  'preparing',
  'shipped',
  'completed',
]

function getPaidOrderTime(order) {
  return order.paid_at || order.updated_at || order.created_at || null
}

function formatDashboardPaidOrder(order, source, authorPageMap = new Map()) {
  const buyerProfile =
    order.buyer_profile && typeof order.buyer_profile === 'object'
      ? order.buyer_profile
      : {}
  const authorPage = authorPageMap.get(String(order.author_page_id || '')) || null
  const isAuthorStore = source === 'author_store'

  return {
    id: order.id,
    source,
    source_label: isAuthorStore ? 'All Author Store' : 'Shadow Mall',
    store_name: isAuthorStore
      ? authorPage?.page_name || authorPage?.page_username || 'Author Store'
      : 'Shadow Mall',
    author_page_id: order.author_page_id || null,
    order_id: order.order_id || order.order_number || order.id,
    buyer_name:
      order.buyer_name ||
      buyerProfile.name ||
      buyerProfile.full_name ||
      buyerProfile.buyer_name ||
      'Reader',
    total_usd: Number(order.total_usd || order.total_amount || 0),
    currency: order.currency || 'USD',
    status: order.order_status || order.status || '',
    payment_status:
      order.payment_status ||
      (DASHBOARD_MALL_PAID_STATUSES.includes(String(order.status || ''))
        ? 'paid'
        : ''),
    paid_at: order.paid_at || null,
    created_at: order.created_at || null,
    updated_at: order.updated_at || null,
    items: Array.isArray(order.items) ? order.items : [],
  }
}

export async function getAdminDashboardGrowth(req, res) {
  try {
    const { startIso, nowIso } = getCambodiaDayRange()

    const [
      newReadersSettled,
      newAuthorsSettled,
      mallOrdersSettled,
      authorStoreOrdersSettled,
    ] = await Promise.allSettled([
      supabase
        .from('users')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', startIso)
        .lte('created_at', nowIso),
      supabase
        .from('author_pages')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', startIso)
        .lte('created_at', nowIso),
      supabase
        .from('shadow_mall_orders')
        .select('id', { count: 'exact', head: true })
        .in('status', DASHBOARD_MALL_PAID_STATUSES)
        .gte('paid_at', startIso)
        .lte('paid_at', nowIso),
      supabase
        .from('author_store_orders')
        .select('id', { count: 'exact', head: true })
        .eq('payment_status', 'paid')
        .gte('paid_at', startIso)
        .lte('paid_at', nowIso),
    ])

    const summary = {}
    const failed = []

    const newReadersResult =
      newReadersSettled.status === 'fulfilled' ? newReadersSettled.value : null
    const newAuthorsResult =
      newAuthorsSettled.status === 'fulfilled' ? newAuthorsSettled.value : null
    const mallOrdersResult =
      mallOrdersSettled.status === 'fulfilled' ? mallOrdersSettled.value : null
    const authorStoreOrdersResult =
      authorStoreOrdersSettled.status === 'fulfilled'
        ? authorStoreOrdersSettled.value
        : null

    if (newReadersResult && !newReadersResult.error) {
      summary.new_readers = Number(newReadersResult.count || 0)
    } else {
      failed.push('new_readers')
      console.error(
        'GET ADMIN DASHBOARD GROWTH NEW READERS ERROR:',
        newReadersResult?.error || newReadersSettled.reason
      )
    }

    if (newAuthorsResult && !newAuthorsResult.error) {
      summary.new_authors = Number(newAuthorsResult.count || 0)
    } else {
      failed.push('new_authors')
      console.error(
        'GET ADMIN DASHBOARD GROWTH NEW AUTHORS ERROR:',
        newAuthorsResult?.error || newAuthorsSettled.reason
      )
    }

    const mallOrdersOk = Boolean(mallOrdersResult && !mallOrdersResult.error)
    const authorStoreOrdersOk = Boolean(
      authorStoreOrdersResult && !authorStoreOrdersResult.error
    )

    if (mallOrdersOk && authorStoreOrdersOk) {
      const shadowMallOrders = Number(mallOrdersResult.count || 0)
      const authorStoreOrders = Number(authorStoreOrdersResult.count || 0)

      summary.new_orders = shadowMallOrders + authorStoreOrders
      summary.shadow_mall_orders = shadowMallOrders
      summary.author_store_orders = authorStoreOrders
    } else {
      if (!mallOrdersOk) {
        failed.push('shadow_mall_orders')
        console.error(
          'GET ADMIN DASHBOARD GROWTH MALL ORDERS ERROR:',
          mallOrdersResult?.error || mallOrdersSettled.reason
        )
      }

      if (!authorStoreOrdersOk) {
        failed.push('author_store_orders')
        console.error(
          'GET ADMIN DASHBOARD GROWTH AUTHOR STORE ORDERS ERROR:',
          authorStoreOrdersResult?.error || authorStoreOrdersSettled.reason
        )
      }
    }

    return res.status(200).json({
      ok: true,
      summary,
      partial: failed.length > 0,
      failed,
    })
  } catch (error) {
    console.error('GET ADMIN DASHBOARD GROWTH ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load dashboard growth summary',
    })
  }
}


export async function getAdminDashboardPaidOrders(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 1000)
    const limit = toPositiveInt(req.query.limit, 20, 100)
    const requestedSource = String(req.query.source || 'all').trim().toLowerCase()
    const source = ['shadow_mall', 'author_store'].includes(requestedSource)
      ? requestedSource
      : 'all'
    const fetchTo = page * limit - 1

    const mallQuery =
      source === 'author_store'
        ? Promise.resolve({ data: [], count: 0, error: null })
        : supabase
            .from('shadow_mall_orders')
            .select('*', { count: 'exact' })
            .in('status', DASHBOARD_MALL_PAID_STATUSES)
            .order('paid_at', { ascending: false, nullsFirst: false })
            .order('created_at', { ascending: false })
            .range(0, fetchTo)

    const authorStoreQuery =
      source === 'shadow_mall'
        ? Promise.resolve({ data: [], count: 0, error: null })
        : supabase
            .from('author_store_orders')
            .select('*, items:author_store_order_items(*)', { count: 'exact' })
            .eq('payment_status', 'paid')
            .order('paid_at', { ascending: false, nullsFirst: false })
            .order('created_at', { ascending: false })
            .range(0, fetchTo)

    const [mallResult, authorStoreResult] = await Promise.all([
      mallQuery,
      authorStoreQuery,
    ])

    if (mallResult.error) throw mallResult.error
    if (authorStoreResult.error) throw authorStoreResult.error

    const authorStoreOrders = authorStoreResult.data || []
    const authorPageIds = [
      ...new Set(
        authorStoreOrders
          .map((order) => order.author_page_id)
          .filter(Boolean)
      ),
    ]
    const authorPageMap = new Map()

    if (authorPageIds.length) {
      const { data: authorPages, error: authorPagesError } = await supabase
        .from('author_pages')
        .select('id, page_name, page_username')
        .in('id', authorPageIds)

      if (authorPagesError) throw authorPagesError

      for (const pageItem of authorPages || []) {
        authorPageMap.set(String(pageItem.id), pageItem)
      }
    }

    const mergedOrders = [
      ...(mallResult.data || []).map((order) =>
        formatDashboardPaidOrder(order, 'shadow_mall')
      ),
      ...authorStoreOrders.map((order) =>
        formatDashboardPaidOrder(order, 'author_store', authorPageMap)
      ),
    ].sort(
      (first, second) =>
        new Date(getPaidOrderTime(second) || 0).getTime() -
        new Date(getPaidOrderTime(first) || 0).getTime()
    )

    const total =
      Number(mallResult.count || 0) +
      Number(authorStoreResult.count || 0)
    const from = (page - 1) * limit
    const orders = mergedOrders.slice(from, from + limit)
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      orders,
      source,
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('GET ADMIN DASHBOARD PAID ORDERS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load paid orders',
    })
  }
}
