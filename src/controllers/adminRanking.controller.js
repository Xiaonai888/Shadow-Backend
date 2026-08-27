import { supabase } from '../config/supabase.js'

const PAGE_SIZE_DEFAULT = 20
const PAGE_SIZE_MAX = 100
const RANKING_VISIBILITY_STATUSES = ['visible', 'hidden']

const DEFAULT_RANKING_SETTINGS = {
  story_view_weight: 1,
  story_like_weight: 5,
  story_comment_weight: 10,
  story_episode_weight: 3,
  author_view_weight: 1,
  author_like_weight: 5,
  author_comment_weight: 10,
  author_follower_weight: 20,
  author_story_weight: 3,
  episode_view_weight: 1,
  episode_like_weight: 5,
  episode_comment_weight: 10,
  min_story_views: 0,
  min_story_likes: 0,
  min_story_comments: 0,
  min_story_episodes: 0,
  min_author_stories: 1,
  min_author_followers: 0,
  min_episode_views: 0,
  min_episode_likes: 0,
  min_episode_comments: 0,
  story_rank_enabled: true,
  genre_rank_enabled: true,
  author_rank_enabled: true,
  episode_rank_enabled: true,
}

async function getRankingSettings() {
  const { data, error } = await supabase
    .from('ranking_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle()

  if (error) throw error

  return {
    ...DEFAULT_RANKING_SETTINGS,
    ...(data || {}),
  }
}

function rankingSettingsKey(settings) {
  return JSON.stringify({
    story_view_weight: Number(settings.story_view_weight),
    story_like_weight: Number(settings.story_like_weight),
    story_comment_weight: Number(settings.story_comment_weight),
    story_episode_weight: Number(settings.story_episode_weight),
    author_view_weight: Number(settings.author_view_weight),
    author_like_weight: Number(settings.author_like_weight),
    author_comment_weight: Number(settings.author_comment_weight),
    author_follower_weight: Number(settings.author_follower_weight),
    author_story_weight: Number(settings.author_story_weight),
    episode_view_weight: Number(settings.episode_view_weight),
    episode_like_weight: Number(settings.episode_like_weight),
    episode_comment_weight: Number(settings.episode_comment_weight),
    min_story_views: Number(settings.min_story_views),
    min_story_likes: Number(settings.min_story_likes),
    min_story_comments: Number(settings.min_story_comments),
    min_story_episodes: Number(settings.min_story_episodes),
    min_author_stories: Number(settings.min_author_stories),
    min_author_followers: Number(settings.min_author_followers),
    min_episode_views: Number(settings.min_episode_views),
    min_episode_likes: Number(settings.min_episode_likes),
    min_episode_comments: Number(settings.min_episode_comments),
    story_rank_enabled: Boolean(settings.story_rank_enabled),
    genre_rank_enabled: Boolean(settings.genre_rank_enabled),
    author_rank_enabled: Boolean(settings.author_rank_enabled),
    episode_rank_enabled: Boolean(settings.episode_rank_enabled),
  })
}

function formatWeight(value) {
  return Number(value || 0).toString()
}

function storyRankFormula(settings) {
  return `score = views*${formatWeight(settings.story_view_weight)} + likes*${formatWeight(settings.story_like_weight)} + comments*${formatWeight(settings.story_comment_weight)} + episodes*${formatWeight(settings.story_episode_weight)}`
}

function authorRankFormula(settings) {
  return `score = views*${formatWeight(settings.author_view_weight)} + likes*${formatWeight(settings.author_like_weight)} + comments*${formatWeight(settings.author_comment_weight)} + followers*${formatWeight(settings.author_follower_weight)} + stories*${formatWeight(settings.author_story_weight)}`
}

function episodeRankFormula(settings) {
  return `score = views*${formatWeight(settings.episode_view_weight)} + likes*${formatWeight(settings.episode_like_weight)} + comments*${formatWeight(settings.episode_comment_weight)}`
}

const GENRE_RANK_CACHE_MS = 15 * 60 * 1000
let genreRankCache = { expiresAt: 0, payload: null, settingsKey: '' }

export async function getAdminGenreRanking(req, res) {
  try {
    const now = Date.now()
    const settings = await getRankingSettings()
    const settingsKey = rankingSettingsKey(settings)

    if (!settings.genre_rank_enabled) {
      return res.status(200).json({
        ok: true,
        enabled: false,
        genres: [],
        rankings: [],
        total: 0,
        total_views: 0,
        metric: 'total_views',
        scope: 'all_time',
        cache_ttl_seconds: GENRE_RANK_CACHE_MS / 1000,
        generated_at: new Date(now).toISOString(),
        cached: false,
      })
    }

    if (
      genreRankCache.payload &&
      genreRankCache.expiresAt > now &&
      genreRankCache.settingsKey === settingsKey
    ) {
      return res.status(200).json({
        ...genreRankCache.payload,
        cached: true,
      })
    }

    const { data, error } = await supabase
      .from('stories')
      .select('id, main_genre, total_views, total_likes, total_comments')
      .is('deleted_at', null)
      .eq('status', 'published')
      .eq('admin_visibility_status', 'active')
      .eq('ranking_visibility_status', 'visible')

    if (error) throw error

    const grouped = new Map()

    for (const story of data || []) {
      const genre = cleanText(story.main_genre)
      if (!genre) continue

      const key = genre.toLowerCase()
      const current = grouped.get(key) || {
        genre,
        story_count: 0,
        total_views: 0,
        total_likes: 0,
        total_comments: 0,
      }

      current.story_count += 1
      current.total_views += Number(story.total_views || 0)
      current.total_likes += Number(story.total_likes || 0)
      current.total_comments += Number(story.total_comments || 0)
      grouped.set(key, current)
    }

    const totalViews = [...grouped.values()].reduce(
      (sum, row) => sum + row.total_views,
      0
    )

    const genres = [...grouped.values()]
      .map((row) => ({
        ...row,
        average_views: row.story_count
          ? Math.round(row.total_views / row.story_count)
          : 0,
        view_share_percent: totalViews
          ? Number(((row.total_views / totalViews) * 100).toFixed(2))
          : 0,
      }))
      .sort(
        (a, b) =>
          b.total_views - a.total_views ||
          b.average_views - a.average_views ||
          b.total_likes - a.total_likes ||
          a.genre.localeCompare(b.genre)
      )
      .map((row, index) => ({ rank: index + 1, ...row }))

    const payload = {
      ok: true,
      enabled: true,
      genres,
      rankings: genres,
      total: genres.length,
      total_views: totalViews,
      metric: 'total_views',
      scope: 'all_time',
      cache_ttl_seconds: GENRE_RANK_CACHE_MS / 1000,
      generated_at: new Date(now).toISOString(),
    }

    genreRankCache = {
      expiresAt: now + GENRE_RANK_CACHE_MS,
      payload,
      settingsKey,
    }

    return res.status(200).json({
      ...payload,
      cached: false,
    })
  } catch (error) {
    console.error('GET ADMIN GENRE RANKING ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load genre ranking',
      error: error.message,
    })
  }
}

const AUTHOR_RANK_CACHE_MS = 15 * 60 * 1000
let authorRankCache = { expiresAt: 0, rows: [], settingsKey: '' }

function scoreAuthorRank(row, settings = DEFAULT_RANKING_SETTINGS) {
  return Number(row.total_views || 0) * Number(settings.author_view_weight || 0)
    + Number(row.total_likes || 0) * Number(settings.author_like_weight || 0)
    + Number(row.total_comments || 0) * Number(settings.author_comment_weight || 0)
    + Number(row.total_followers || 0) * Number(settings.author_follower_weight || 0)
    + Number(row.story_count || 0) * Number(settings.author_story_weight || 0)
}

export async function getAdminAuthorRanking(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit)
    const search = cleanText(
      req.query.q || req.query.search || req.query.keyword
    ).toLowerCase()
    const now = Date.now()
    const settings = await getRankingSettings()
    const settingsKey = rankingSettingsKey(settings)

    if (!settings.author_rank_enabled) {
      return res.status(200).json({
        ok: true,
        enabled: false,
        authors: [],
        rankings: [],
        page,
        limit,
        total: 0,
        total_pages: 1,
        has_next: false,
        has_prev: page > 1,
        metric: 'score',
        scope: 'all_time',
        formula: authorRankFormula(settings),
        cache_ttl_seconds: AUTHOR_RANK_CACHE_MS / 1000,
        cached: false,
      })
    }

    let rows = authorRankCache.rows
    let cached =
      authorRankCache.expiresAt > now &&
      rows.length > 0 &&
      authorRankCache.settingsKey === settingsKey

    if (!cached) {
      const [pagesResult, storiesResult] = await Promise.all([
        supabase
          .from('author_pages')
          .select('id, user_id, page_name, page_username, avatar_url, total_followers, status, ranking_visibility_status, ranking_hidden_reason, ranking_hidden_at, ranking_hidden_by, ranking_note')
          .eq('status', 'active')
          .eq('ranking_visibility_status', 'visible'),
        supabase
          .from('stories')
          .select('author_id, total_views, total_likes, total_comments')
          .is('deleted_at', null)
          .eq('status', 'published')
          .eq('admin_visibility_status', 'active')
          .eq('ranking_visibility_status', 'visible'),
      ])

      if (pagesResult.error) throw pagesResult.error
      if (storiesResult.error) throw storiesResult.error

      const stats = new Map()

      for (const story of storiesResult.data || []) {
        if (!story.author_id) continue

        const current = stats.get(story.author_id) || {
          story_count: 0,
          total_views: 0,
          total_likes: 0,
          total_comments: 0,
        }

        current.story_count += 1
        current.total_views += Number(story.total_views || 0)
        current.total_likes += Number(story.total_likes || 0)
        current.total_comments += Number(story.total_comments || 0)
        stats.set(story.author_id, current)
      }

      rows = (pagesResult.data || [])
        .map((author) => {
          const stat = stats.get(author.id) || {
            story_count: 0,
            total_views: 0,
            total_likes: 0,
            total_comments: 0,
          }

          const row = {
            id: author.id,
            author_id: author.id,
            user_id: author.user_id,
            page_name: author.page_name,
            page_username: author.page_username,
            avatar_url: author.avatar_url,
            status: author.status,
            ranking_visibility_status: author.ranking_visibility_status || 'visible',
            ranking_hidden_reason: author.ranking_hidden_reason || '',
            ranking_hidden_at: author.ranking_hidden_at || null,
            ranking_hidden_by: author.ranking_hidden_by || '',
            ranking_note: author.ranking_note || '',
            story_count: stat.story_count,
            total_followers: Number(author.total_followers || 0),
            total_views: stat.total_views,
            total_likes: stat.total_likes,
            total_comments: stat.total_comments,
          }

          return {
            ...row,
            score: scoreAuthorRank(row, settings),
          }
        })
        .filter(
          (row) =>
            row.story_count >= Number(settings.min_author_stories || 0) &&
            row.total_followers >= Number(settings.min_author_followers || 0)
        )
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.total_views - a.total_views ||
            b.total_followers - a.total_followers ||
            String(a.page_name || '').localeCompare(String(b.page_name || ''))
        )
        .map((row, index) => ({ rank: index + 1, ...row }))

      authorRankCache = {
        expiresAt: now + AUTHOR_RANK_CACHE_MS,
        rows,
        settingsKey,
      }
      cached = false
    }

    const filtered = search
      ? rows.filter((row) =>
          [row.id, row.user_id, row.page_name, row.page_username]
            .some((value) =>
              String(value || '').toLowerCase().includes(search)
            )
        )
      : rows

    const total = filtered.length
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const from = (page - 1) * limit
    const authors = filtered.slice(from, from + limit)

    return res.status(200).json({
      ok: true,
      enabled: true,
      authors,
      rankings: authors,
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
      metric: 'score',
      scope: 'all_time',
      formula: authorRankFormula(settings),
      minimum_activity: {
        stories: Number(settings.min_author_stories || 0),
        followers: Number(settings.min_author_followers || 0),
      },
      cache_ttl_seconds: AUTHOR_RANK_CACHE_MS / 1000,
      cached,
    })
  } catch (error) {
    console.error('GET ADMIN AUTHOR RANKING ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load author ranking',
      error: error.message,
    })
  }
}

const EPISODE_RANK_CACHE_MS = 15 * 60 * 1000
let episodeRankCache = { expiresAt: 0, rows: [], settingsKey: '' }

function scoreEpisodeRank(row, settings = DEFAULT_RANKING_SETTINGS) {
  return Number(row.total_views || 0) * Number(settings.episode_view_weight || 0)
    + Number(row.total_likes || 0) * Number(settings.episode_like_weight || 0)
    + Number(row.total_comments || 0) * Number(settings.episode_comment_weight || 0)
}

export async function getAdminEpisodeRanking(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit)
    const search = cleanText(
      req.query.q || req.query.search || req.query.keyword
    ).toLowerCase()
    const now = Date.now()
    const settings = await getRankingSettings()
    const settingsKey = rankingSettingsKey(settings)

    if (!settings.episode_rank_enabled) {
      return res.status(200).json({
        ok: true,
        enabled: false,
        episodes: [],
        rankings: [],
        page,
        limit,
        total: 0,
        total_pages: 1,
        has_next: false,
        has_prev: page > 1,
        metric: 'score',
        scope: 'all_time',
        formula: episodeRankFormula(settings),
        cache_ttl_seconds: EPISODE_RANK_CACHE_MS / 1000,
        cached: false,
      })
    }

    let rows = episodeRankCache.rows
    let cached =
      episodeRankCache.expiresAt > now &&
      rows.length > 0 &&
      episodeRankCache.settingsKey === settingsKey

    if (!cached) {
      const { data: stories, error: storyError } = await supabase
        .from('stories')
        .select('id, title, author_id')
        .is('deleted_at', null)
        .eq('status', 'published')
        .eq('admin_visibility_status', 'active')
        .eq('ranking_visibility_status', 'visible')

      if (storyError) throw storyError

      const storyIds = (stories || [])
        .map((story) => story.id)
        .filter(Boolean)

      if (!storyIds.length) {
        rows = []
      } else {
        const { data: episodes, error: episodeError } = await supabase
          .from('episodes')
          .select('id, story_id, title, episode_number, total_views, total_likes, status, ranking_visibility_status, ranking_hidden_reason, ranking_hidden_at, ranking_hidden_by, ranking_note')
          .in('story_id', storyIds)
          .is('deleted_at', null)
          .eq('status', 'published')
          .eq('ranking_visibility_status', 'visible')

        if (episodeError) throw episodeError

        const episodeIds = (episodes || [])
          .map((episode) => episode.id)
          .filter(Boolean)
        const authorIds = [
          ...new Set(
            (stories || [])
              .map((story) => story.author_id)
              .filter(Boolean)
          ),
        ]

        const [commentsResult, authorsResult] = await Promise.all([
          episodeIds.length
            ? supabase
                .from('comments')
                .select('episode_id')
                .in('episode_id', episodeIds)
                .eq('is_hidden', false)
                .is('deleted_at', null)
            : Promise.resolve({ data: [], error: null }),
          authorIds.length
            ? supabase
                .from('author_pages')
                .select('id, page_name, page_username')
                .in('id', authorIds)
            : Promise.resolve({ data: [], error: null }),
        ])

        if (commentsResult.error) throw commentsResult.error
        if (authorsResult.error) throw authorsResult.error

        const commentCounts = new Map()
        for (const comment of commentsResult.data || []) {
          const key = String(comment.episode_id || '')
          if (!key) continue
          commentCounts.set(
            key,
            Number(commentCounts.get(key) || 0) + 1
          )
        }

        const storyMap = new Map(
          (stories || []).map((story) => [story.id, story])
        )
        const authorMap = new Map(
          (authorsResult.data || []).map((author) => [
            author.id,
            author,
          ])
        )

        rows = (episodes || [])
          .map((episode) => {
            const story = storyMap.get(episode.story_id) || {}
            const author = authorMap.get(story.author_id) || {}

            const row = {
              id: episode.id,
              episode_id: episode.id,
              story_id: episode.story_id,
              story_title: story.title || 'Untitled Story',
              author_id: story.author_id || null,
              author_name: author.page_name || 'Unknown Author',
              author_username: author.page_username || '',
              title: episode.title || 'Untitled Episode',
              episode_number: Number(episode.episode_number || 0),
              total_views: Number(episode.total_views || 0),
              total_likes: Number(episode.total_likes || 0),
              total_comments: Number(
                commentCounts.get(String(episode.id)) || 0
              ),
              status: episode.status || 'published',
              ranking_visibility_status:
                episode.ranking_visibility_status || 'visible',
              ranking_hidden_reason:
                episode.ranking_hidden_reason || '',
              ranking_hidden_at:
                episode.ranking_hidden_at || null,
              ranking_hidden_by:
                episode.ranking_hidden_by || '',
              ranking_note: episode.ranking_note || '',
            }

            return {
              ...row,
              score: scoreEpisodeRank(row, settings),
            }
          })
          .filter(
            (row) =>
              row.total_views >= Number(settings.min_episode_views || 0) &&
              row.total_likes >= Number(settings.min_episode_likes || 0) &&
              row.total_comments >= Number(settings.min_episode_comments || 0)
          )
          .sort(
            (a, b) =>
              b.score - a.score ||
              b.total_views - a.total_views ||
              b.total_likes - a.total_likes ||
              a.episode_number - b.episode_number
          )
          .map((row, index) => ({
            rank: index + 1,
            ...row,
          }))
      }

      episodeRankCache = {
        expiresAt: now + EPISODE_RANK_CACHE_MS,
        rows,
        settingsKey,
      }
      cached = false
    }

    const filtered = search
      ? rows.filter((row) =>
          [
            row.id,
            row.title,
            row.story_id,
            row.story_title,
            row.author_id,
            row.author_name,
            row.author_username,
          ].some((value) =>
            String(value || '').toLowerCase().includes(search)
          )
        )
      : rows

    const total = filtered.length
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const from = (page - 1) * limit
    const episodes = filtered.slice(from, from + limit)

    return res.status(200).json({
      ok: true,
      enabled: true,
      episodes,
      rankings: episodes,
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
      metric: 'score',
      scope: 'all_time',
      formula: episodeRankFormula(settings),
      minimum_activity: {
        views: Number(settings.min_episode_views || 0),
        likes: Number(settings.min_episode_likes || 0),
        comments: Number(settings.min_episode_comments || 0),
      },
      cache_ttl_seconds: EPISODE_RANK_CACHE_MS / 1000,
      cached,
    })
  } catch (error) {
    console.error('GET ADMIN EPISODE RANKING ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load episode ranking',
      error: error.message,
    })
  }
}

const INCOME_RANK_CACHE_MS = 15 * 60 * 1000
const INCOME_RANK_SOURCE_TYPES = ['diamond_unlock', 'diamond_gift']
const INCOME_RANK_UNPAID_STATUSES = ['pending', 'available']
const INCOME_RANK_PAID_STATUSES = ['paid']
const INCOME_RANK_PAGE_SIZE = 1000
const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
let incomeRankCache = { expiresAt: 0, rows: [] }

function getIncomeRankMonthStartIso(date = new Date()) {
  const cambodiaDate = new Date(date.getTime() + CAMBODIA_OFFSET_MS)

  return new Date(
    Date.UTC(
      cambodiaDate.getUTCFullYear(),
      cambodiaDate.getUTCMonth(),
      1
    ) - CAMBODIA_OFFSET_MS
  ).toISOString()
}

async function fetchAllIncomeRankRows() {
  const rows = []
  let from = 0

  while (true) {
    const { data, error } = await supabase
      .from('author_earnings')
      .select(
        'author_id, source_type, author_earned_diamonds, author_net_payout_usd, earning_status, created_at'
      )
      .eq('currency', 'diamond')
      .in('source_type', INCOME_RANK_SOURCE_TYPES)
      .neq('earning_status', 'void')
      .order('created_at', { ascending: true })
      .range(from, from + INCOME_RANK_PAGE_SIZE - 1)

    if (error) throw error

    rows.push(...(data || []))

    if (!data || data.length < INCOME_RANK_PAGE_SIZE) break

    from += INCOME_RANK_PAGE_SIZE
  }

  return rows
}

export async function getAdminIncomeRanking(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit)
    const search = cleanText(
      req.query.q || req.query.search || req.query.keyword
    ).toLowerCase()
    const now = Date.now()
    const monthStartIso = getIncomeRankMonthStartIso(new Date(now))
    const monthStartTime = new Date(monthStartIso).getTime()

    let rows = incomeRankCache.rows
    let cached = incomeRankCache.expiresAt > now && rows.length > 0

    if (!cached) {
      const earningRows = await fetchAllIncomeRankRows()
      const grouped = new Map()

      for (const earning of earningRows) {
        if (!earning.author_id) continue

        const current = grouped.get(earning.author_id) || {
          author_id: earning.author_id,
          total_income_usd: 0,
          this_month_usd: 0,
          pending_usd: 0,
          paid_usd: 0,
          total_diamonds: 0,
          transaction_count: 0,
        }

        const payoutUsd = Number(earning.author_net_payout_usd || 0)
        const earnedDiamonds = Number(earning.author_earned_diamonds || 0)
        const status = String(earning.earning_status || '')
        const createdTime = new Date(earning.created_at || 0).getTime()

        current.total_income_usd += payoutUsd
        current.total_diamonds += earnedDiamonds
        current.transaction_count += 1

        if (Number.isFinite(createdTime) && createdTime >= monthStartTime) {
          current.this_month_usd += payoutUsd
        }

        if (INCOME_RANK_UNPAID_STATUSES.includes(status)) {
          current.pending_usd += payoutUsd
        }

        if (INCOME_RANK_PAID_STATUSES.includes(status)) {
          current.paid_usd += payoutUsd
        }

        grouped.set(earning.author_id, current)
      }

      const authorIds = [...grouped.keys()]
      const authors = await fetchAuthors(authorIds)

      rows = [...grouped.values()]
        .map((row) => {
          const author = authors.get(row.author_id) || {}

          return {
            id: row.author_id,
            author_id: row.author_id,
            user_id: author.user_id || null,
            page_name: author.page_name || 'Unknown Author',
            page_username: author.page_username || '',
            avatar_url: author.avatar_url || '',
            status: author.status || 'unknown',
            admin_status: author.admin_status || 'active',
            total_income_usd: Number(row.total_income_usd.toFixed(2)),
            this_month_usd: Number(row.this_month_usd.toFixed(2)),
            pending_usd: Number(row.pending_usd.toFixed(2)),
            paid_usd: Number(row.paid_usd.toFixed(2)),
            total_diamonds: Number(row.total_diamonds || 0),
            transaction_count: Number(row.transaction_count || 0),
          }
        })
        .sort(
          (a, b) =>
            b.total_income_usd - a.total_income_usd ||
            b.this_month_usd - a.this_month_usd ||
            b.pending_usd - a.pending_usd ||
            String(a.page_name || '').localeCompare(String(b.page_name || ''))
        )
        .map((row, index) => ({ rank: index + 1, ...row }))

      incomeRankCache = {
        expiresAt: now + INCOME_RANK_CACHE_MS,
        rows,
      }
      cached = false
    }

    const filtered = search
      ? rows.filter((row) =>
          [
            row.id,
            row.user_id,
            row.page_name,
            row.page_username,
          ].some((value) =>
            String(value || '').toLowerCase().includes(search)
          )
        )
      : rows

    const total = filtered.length
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const from = (page - 1) * limit
    const authors = filtered.slice(from, from + limit)

    return res.status(200).json({
      ok: true,
      authors,
      rankings: authors,
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
      metric: 'author_net_payout_usd',
      scope: 'all_time',
      sources: INCOME_RANK_SOURCE_TYPES,
      month_start: monthStartIso,
      cache_ttl_seconds: INCOME_RANK_CACHE_MS / 1000,
      generated_at: new Date(now).toISOString(),
      cached,
    })
  } catch (error) {
    console.error('GET ADMIN INCOME RANKING ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load income ranking',
      error: error.message,
    })
  }
}


function cleanText(value) {
  return String(value || '').trim()
}

function normalizePage(value) {
  const page = Number(value)
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.floor(page)
}

function normalizeLimit(value) {
  const limit = Number(value)
  if (!Number.isFinite(limit) || limit < 1) return PAGE_SIZE_DEFAULT
  return Math.min(Math.floor(limit), PAGE_SIZE_MAX)
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim())
}

function normalizeSort(value) {
  const sort = cleanText(value || 'score').toLowerCase()
  if (['views', 'likes', 'comments', 'episodes', 'newest'].includes(sort)) return sort
  return 'score'
}

function adminActor(req) {
  return cleanText(req.admin?.email || req.admin?.username || req.admin?.admin_name || req.admin?.user_id || req.headers['x-admin-name'] || req.headers['x-admin-actor'] || 'Admin')
}

function scoreStory(story, settings = DEFAULT_RANKING_SETTINGS) {
  return Number(story.total_views || 0) * Number(settings.story_view_weight || 0)
    + Number(story.total_likes || 0) * Number(settings.story_like_weight || 0)
    + Number(story.total_comments || 0) * Number(settings.story_comment_weight || 0)
    + Number(story.total_episodes || 0) * Number(settings.story_episode_weight || 0)
}

function publicAuthor(author) {
  if (!author) return null

  return {
    id: author.id,
    user_id: author.user_id,
    page_name: author.page_name,
    page_username: author.page_username,
    page_slug: author.page_slug,
    avatar_url: author.avatar_url,
    status: author.status,
    admin_status: author.admin_status || 'active',
  }
}

function publicStoryRank(
  story,
  author,
  rank,
  settings = DEFAULT_RANKING_SETTINGS
) {
  const score = scoreStory(story, settings)

  return {
    rank,
    id: story.id,
    author_id: story.author_id,
    user_id: story.user_id,
    title: story.title,
    story_language: story.story_language,
    main_genre: story.main_genre,
    cover_url: story.cover_url,
    status: story.status,
    admin_visibility_status:
      story.admin_visibility_status || 'active',
    ranking_visibility_status:
      story.ranking_visibility_status || 'visible',
    ranking_hidden_reason:
      story.ranking_hidden_reason || '',
    ranking_hidden_at:
      story.ranking_hidden_at || null,
    ranking_hidden_by:
      story.ranking_hidden_by || '',
    ranking_note: story.ranking_note || '',
    total_episodes: Number(story.total_episodes || 0),
    total_views: Number(story.total_views || 0),
    total_likes: Number(story.total_likes || 0),
    total_comments: Number(story.total_comments || 0),
    score,
    rank_score: score,
    author_page: publicAuthor(author),
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

async function fetchAuthors(authorIds) {
  const ids = [...new Set((authorIds || []).filter(Boolean))]
  if (!ids.length) return new Map()

  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id, page_name, page_username, page_slug, avatar_url, status, admin_status')
    .in('id', ids)

  if (error) throw error

  return new Map(
    (data || []).map((author) => [author.id, author])
  )
}

function applySort(
  rows,
  sort,
  settings = DEFAULT_RANKING_SETTINGS
) {
  const sorted = [...rows]

  if (sort === 'views') {
    return sorted.sort(
      (a, b) =>
        Number(b.total_views || 0) -
        Number(a.total_views || 0)
    )
  }

  if (sort === 'likes') {
    return sorted.sort(
      (a, b) =>
        Number(b.total_likes || 0) -
        Number(a.total_likes || 0)
    )
  }

  if (sort === 'comments') {
    return sorted.sort(
      (a, b) =>
        Number(b.total_comments || 0) -
        Number(a.total_comments || 0)
    )
  }

  if (sort === 'episodes') {
    return sorted.sort(
      (a, b) =>
        Number(b.total_episodes || 0) -
        Number(a.total_episodes || 0)
    )
  }

  if (sort === 'newest') {
    return sorted.sort(
      (a, b) =>
        new Date(b.created_at || 0).getTime() -
        new Date(a.created_at || 0).getTime()
    )
  }

  return sorted.sort(
    (a, b) =>
      scoreStory(b, settings) -
      scoreStory(a, settings)
  )
}

function buildStoryRankingQuery({
  search,
  status,
  visibility,
  rankingVisibility,
  genre,
}) {
  let query = supabase
    .from('stories')
    .select('*')
    .is('deleted_at', null)

  if (status !== 'all') {
    query = query.eq('status', status)
  }

  if (visibility !== 'all') {
    query = query.eq(
      'admin_visibility_status',
      visibility
    )
  }

  if (rankingVisibility !== 'all') {
    query = query.eq(
      'ranking_visibility_status',
      rankingVisibility
    )
  }

  if (genre !== 'all') {
    query = query.eq('main_genre', genre)
  }

  if (search) {
    if (isUuid(search)) {
      query = query.eq('id', search)
    } else {
      const safeSearch = search.replace(
        /[%_]/g,
        '\\$&'
      )
      query = query.or(
        `title.ilike.%${safeSearch}%,main_genre.ilike.%${safeSearch}%,story_language.ilike.%${safeSearch}%`
      )
    }
  }

  return query
}

export async function getAdminStoryRanking(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit)
    const sort = normalizeSort(
      req.query.sort || req.query.metric
    )
    const search = cleanText(
      req.query.q ||
        req.query.search ||
        req.query.keyword
    )
    const status = cleanText(
      req.query.status || 'published'
    ).toLowerCase()
    const visibility = cleanText(
      req.query.visibility || 'active'
    ).toLowerCase()
    const rankingVisibility = cleanText(
      req.query.ranking_visibility ||
        req.query.rankingVisibility ||
        'visible'
    ).toLowerCase()
    const genre = cleanText(
      req.query.genre || 'all'
    )
    const settings = await getRankingSettings()

    if (!settings.story_rank_enabled) {
      return res.status(200).json({
        ok: true,
        enabled: false,
        stories: [],
        rankings: [],
        page,
        limit,
        total: 0,
        total_pages: 1,
        has_next: false,
        has_prev: page > 1,
        sort,
        filters: {
          status,
          visibility,
          ranking_visibility: rankingVisibility,
          genre,
          genres: [],
        },
        formula: storyRankFormula(settings),
      })
    }

    const { data, error } =
      await buildStoryRankingQuery({
        search,
        status,
        visibility,
        rankingVisibility,
        genre,
      })

    if (error) throw error

    const qualifiedRows = (data || []).filter(
      (story) =>
        Number(story.total_views || 0) >=
          Number(settings.min_story_views || 0) &&
        Number(story.total_likes || 0) >=
          Number(settings.min_story_likes || 0) &&
        Number(story.total_comments || 0) >=
          Number(settings.min_story_comments || 0) &&
        Number(story.total_episodes || 0) >=
          Number(settings.min_story_episodes || 0)
    )

    const rows = applySort(
      qualifiedRows,
      sort,
      settings
    )
    const total = rows.length
    const totalPages = Math.max(
      1,
      Math.ceil(total / limit)
    )
    const from = (page - 1) * limit
    const pageRows = rows.slice(
      from,
      from + limit
    )
    const authors = await fetchAuthors(
      pageRows.map((story) => story.author_id)
    )
    const stories = pageRows.map(
      (story, index) =>
        publicStoryRank(
          story,
          authors.get(story.author_id),
          from + index + 1,
          settings
        )
    )
    const genreValues = [
      ...new Set(
        qualifiedRows
          .map((story) => story.main_genre)
          .filter(Boolean)
      ),
    ].sort()

    return res.status(200).json({
      ok: true,
      enabled: true,
      stories,
      rankings: stories,
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
      sort,
      filters: {
        status,
        visibility,
        ranking_visibility:
          rankingVisibility,
        genre,
        genres: genreValues,
      },
      minimum_activity: {
        views: Number(
          settings.min_story_views || 0
        ),
        likes: Number(
          settings.min_story_likes || 0
        ),
        comments: Number(
          settings.min_story_comments || 0
        ),
        episodes: Number(
          settings.min_story_episodes || 0
        ),
      },
      formula: storyRankFormula(settings),
    })
  } catch (error) {
    console.error(
      'GET ADMIN STORY RANKING ERROR:',
      error
    )
    return res.status(500).json({
      ok: false,
      message: 'Failed to load story ranking',
      error: error.message,
    })
  }
}

export async function getHiddenRankingItems(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit)
    const search = cleanText(req.query.q || req.query.search || req.query.keyword).toLowerCase()

    const [storiesResult, authorsResult, episodesResult] = await Promise.all([
      supabase
        .from('stories')
        .select('*')
        .eq('ranking_visibility_status', 'hidden'),
      supabase
        .from('author_pages')
        .select('id, user_id, page_name, page_username, avatar_url, status, admin_status, ranking_visibility_status, ranking_hidden_reason, ranking_hidden_at, ranking_hidden_by, ranking_note')
        .eq('ranking_visibility_status', 'hidden'),
      supabase
        .from('episodes')
        .select('id, story_id, title, episode_number, cover_url, status, ranking_visibility_status, ranking_hidden_reason, ranking_hidden_at, ranking_hidden_by, ranking_note')
        .eq('ranking_visibility_status', 'hidden')
        .is('deleted_at', null),
    ])

    if (storiesResult.error) throw storiesResult.error
    if (authorsResult.error) throw authorsResult.error
    if (episodesResult.error) throw episodesResult.error

    const hiddenStories = storiesResult.data || []
    const hiddenAuthors = authorsResult.data || []
    const hiddenEpisodes = episodesResult.data || []

    const episodeStoryIds = [...new Set(hiddenEpisodes.map((episode) => episode.story_id).filter(Boolean))]
    const authorIds = [
      ...new Set([
        ...hiddenStories.map((story) => story.author_id),
        ...hiddenAuthors.map((author) => author.id),
      ].filter(Boolean)),
    ]

    let episodeStories = []
    if (episodeStoryIds.length) {
      const { data, error } = await supabase
        .from('stories')
        .select('id, title, author_id')
        .in('id', episodeStoryIds)

      if (error) throw error
      episodeStories = data || []

      for (const story of episodeStories) {
        if (story.author_id) authorIds.push(story.author_id)
      }
    }

    const authorMap = await fetchAuthors(authorIds)
    const storyMap = new Map(episodeStories.map((story) => [story.id, story]))

    const items = [
      ...hiddenStories.map((story) => ({
        item_type: 'story',
        type: 'story',
        id: story.id,
        story_id: story.id,
        author_id: story.author_id,
        name: story.title || 'Untitled Story',
        title: story.title || 'Untitled Story',
        cover_url: story.cover_url || '',
        author_page: publicAuthor(authorMap.get(story.author_id)),
        ranking_visibility_status: 'hidden',
        ranking_hidden_reason: story.ranking_hidden_reason || '',
        ranking_hidden_at: story.ranking_hidden_at || null,
        ranking_hidden_by: story.ranking_hidden_by || '',
        ranking_note: story.ranking_note || '',
      })),
      ...hiddenAuthors.map((author) => ({
        item_type: 'author',
        type: 'author',
        id: author.id,
        author_id: author.id,
        user_id: author.user_id,
        name: author.page_name || 'Unknown Author',
        title: author.page_name || 'Unknown Author',
        page_name: author.page_name || 'Unknown Author',
        page_username: author.page_username || '',
        avatar_url: author.avatar_url || '',
        status: author.status || 'active',
        admin_status: author.admin_status || 'active',
        ranking_visibility_status: 'hidden',
        ranking_hidden_reason: author.ranking_hidden_reason || '',
        ranking_hidden_at: author.ranking_hidden_at || null,
        ranking_hidden_by: author.ranking_hidden_by || '',
        ranking_note: author.ranking_note || '',
      })),
      ...hiddenEpisodes.map((episode) => {
        const story = storyMap.get(episode.story_id) || {}
        const author = authorMap.get(story.author_id) || {}

        return {
          item_type: 'episode',
          type: 'episode',
          id: episode.id,
          episode_id: episode.id,
          story_id: episode.story_id,
          story_title: story.title || 'Untitled Story',
          author_id: story.author_id || null,
          author_name: author.page_name || 'Unknown Author',
          author_username: author.page_username || '',
          name: episode.title || 'Untitled Episode',
          title: episode.title || 'Untitled Episode',
          episode_number: Number(episode.episode_number || 0),
          cover_url: episode.cover_url || '',
          status: episode.status || 'published',
          ranking_visibility_status: 'hidden',
          ranking_hidden_reason: episode.ranking_hidden_reason || '',
          ranking_hidden_at: episode.ranking_hidden_at || null,
          ranking_hidden_by: episode.ranking_hidden_by || '',
          ranking_note: episode.ranking_note || '',
        }
      }),
    ]

    const filtered = search
      ? items.filter((item) =>
          [
            item.id,
            item.name,
            item.title,
            item.page_name,
            item.page_username,
            item.story_id,
            item.story_title,
            item.author_id,
            item.author_name,
            item.author_username,
            item.ranking_hidden_reason,
            item.ranking_hidden_by,
          ].some((value) => String(value || '').toLowerCase().includes(search))
        )
      : items

    filtered.sort(
      (a, b) =>
        new Date(b.ranking_hidden_at || 0).getTime() -
        new Date(a.ranking_hidden_at || 0).getTime()
    )

    const total = filtered.length
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const from = (page - 1) * limit
    const pageItems = filtered.slice(from, from + limit)

    return res.status(200).json({
      ok: true,
      items: pageItems,
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
      counts: {
        stories: hiddenStories.length,
        authors: hiddenAuthors.length,
        episodes: hiddenEpisodes.length,
      },
    })
  } catch (error) {
    console.error('GET HIDDEN RANKING ITEMS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load hidden ranking items',
      error: error.message,
    })
  }
}

function rankingVisibilityInput(req) {
  return {
    rankingVisibility: cleanText(
      req.body.ranking_visibility_status ||
        req.body.ranking_visibility ||
        req.body.visibility
    ).toLowerCase(),
    reason: cleanText(req.body.reason || req.body.ranking_hidden_reason),
    note: cleanText(req.body.note || req.body.ranking_note),
    actor: adminActor(req),
  }
}

function rankingVisibilityValidation(res, rankingVisibility, reason) {
  if (!RANKING_VISIBILITY_STATUSES.includes(rankingVisibility)) {
    res.status(400).json({
      ok: false,
      message: 'Invalid ranking visibility status',
    })
    return false
  }

  if (rankingVisibility === 'hidden' && reason.length < 5) {
    res.status(400).json({
      ok: false,
      message: 'Hidden reason is required',
    })
    return false
  }

  return true
}

function rankingVisibilityPayload(oldItem, rankingVisibility, reason, note, actor) {
  const now = new Date().toISOString()

  return {
    now,
    payload: {
      ranking_visibility_status: rankingVisibility,
      ranking_hidden_reason: rankingVisibility === 'hidden' ? reason : '',
      ranking_hidden_at: rankingVisibility === 'hidden' ? now : null,
      ranking_hidden_by: rankingVisibility === 'hidden' ? actor : '',
      ranking_note: note || oldItem.ranking_note || '',
      updated_at: now,
    },
  }
}

export async function updateStoryRankingVisibility(req, res) {
  try {
    const { storyId } = req.params
    const { rankingVisibility, reason, note, actor } = rankingVisibilityInput(req)

    if (!rankingVisibilityValidation(res, rankingVisibility, reason)) return

    const { data: oldStory, error: oldStoryError } = await supabase
      .from('stories')
      .select('*')
      .eq('id', storyId)
      .maybeSingle()

    if (oldStoryError) throw oldStoryError
    if (!oldStory) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const { payload } = rankingVisibilityPayload(
      oldStory,
      rankingVisibility,
      reason,
      note,
      actor
    )

    const { data: story, error: updateError } = await supabase
      .from('stories')
      .update(payload)
      .eq('id', storyId)
      .select()
      .single()

    if (updateError) throw updateError

    genreRankCache = { expiresAt: 0, payload: null }
    authorRankCache = { expiresAt: 0, rows: [] }
    episodeRankCache = { expiresAt: 0, rows: [] }

    await supabase.from('ranking_moderation_logs').insert({
      item_type: 'story',
      item_id: storyId,
      story_id: storyId,
      author_id: story.author_id,
      action:
        rankingVisibility === 'hidden'
          ? 'story_hidden_from_ranking'
          : 'story_unhidden_from_ranking',
      reason:
        rankingVisibility === 'hidden'
          ? reason
          : 'Story restored to ranking by admin',
      admin_actor: actor,
    })

    const authors = await fetchAuthors([story.author_id])

    return res.status(200).json({
      ok: true,
      message:
        rankingVisibility === 'hidden'
          ? 'Story hidden from ranking'
          : 'Story restored to ranking',
      story: publicStoryRank(story, authors.get(story.author_id), null),
    })
  } catch (error) {
    console.error('UPDATE STORY RANKING VISIBILITY ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to update ranking visibility',
      error: error.message,
    })
  }
}

export async function updateAuthorRankingVisibility(req, res) {
  try {
    const { authorId } = req.params
    const { rankingVisibility, reason, note, actor } = rankingVisibilityInput(req)

    if (!rankingVisibilityValidation(res, rankingVisibility, reason)) return

    const { data: oldAuthor, error: oldAuthorError } = await supabase
      .from('author_pages')
      .select('*')
      .eq('id', authorId)
      .maybeSingle()

    if (oldAuthorError) throw oldAuthorError
    if (!oldAuthor) {
      return res.status(404).json({
        ok: false,
        message: 'Author not found',
      })
    }

    const { payload } = rankingVisibilityPayload(
      oldAuthor,
      rankingVisibility,
      reason,
      note,
      actor
    )

    const { data: author, error: updateError } = await supabase
      .from('author_pages')
      .update(payload)
      .eq('id', authorId)
      .select()
      .single()

    if (updateError) throw updateError

    authorRankCache = { expiresAt: 0, rows: [] }

    await supabase.from('ranking_moderation_logs').insert({
      item_type: 'author',
      item_id: authorId,
      author_id: authorId,
      action:
        rankingVisibility === 'hidden'
          ? 'author_hidden_from_ranking'
          : 'author_unhidden_from_ranking',
      reason:
        rankingVisibility === 'hidden'
          ? reason
          : 'Author restored to ranking by admin',
      admin_actor: actor,
    })

    return res.status(200).json({
      ok: true,
      message:
        rankingVisibility === 'hidden'
          ? 'Author hidden from ranking'
          : 'Author restored to ranking',
      author: {
        id: author.id,
        author_id: author.id,
        user_id: author.user_id,
        page_name: author.page_name,
        page_username: author.page_username,
        avatar_url: author.avatar_url,
        status: author.status,
        admin_status: author.admin_status || 'active',
        ranking_visibility_status:
          author.ranking_visibility_status || 'visible',
        ranking_hidden_reason: author.ranking_hidden_reason || '',
        ranking_hidden_at: author.ranking_hidden_at || null,
        ranking_hidden_by: author.ranking_hidden_by || '',
        ranking_note: author.ranking_note || '',
      },
    })
  } catch (error) {
    console.error('UPDATE AUTHOR RANKING VISIBILITY ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to update author ranking visibility',
      error: error.message,
    })
  }
}

export async function updateEpisodeRankingVisibility(req, res) {
  try {
    const { episodeId } = req.params
    const { rankingVisibility, reason, note, actor } = rankingVisibilityInput(req)

    if (!rankingVisibilityValidation(res, rankingVisibility, reason)) return

    const { data: oldEpisode, error: oldEpisodeError } = await supabase
      .from('episodes')
      .select('*')
      .eq('id', episodeId)
      .maybeSingle()

    if (oldEpisodeError) throw oldEpisodeError
    if (!oldEpisode) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    const { payload } = rankingVisibilityPayload(
      oldEpisode,
      rankingVisibility,
      reason,
      note,
      actor
    )

    const { data: episode, error: updateError } = await supabase
      .from('episodes')
      .update(payload)
      .eq('id', episodeId)
      .select()
      .single()

    if (updateError) throw updateError

    episodeRankCache = { expiresAt: 0, rows: [] }

    const { data: story, error: storyError } = await supabase
      .from('stories')
      .select('id, author_id, title')
      .eq('id', episode.story_id)
      .maybeSingle()

    if (storyError) throw storyError

    await supabase.from('ranking_moderation_logs').insert({
      item_type: 'episode',
      item_id: episodeId,
      story_id: episode.story_id,
      author_id: story?.author_id || null,
      action:
        rankingVisibility === 'hidden'
          ? 'episode_hidden_from_ranking'
          : 'episode_unhidden_from_ranking',
      reason:
        rankingVisibility === 'hidden'
          ? reason
          : 'Episode restored to ranking by admin',
      admin_actor: actor,
    })

    return res.status(200).json({
      ok: true,
      message:
        rankingVisibility === 'hidden'
          ? 'Episode hidden from ranking'
          : 'Episode restored to ranking',
      episode: {
        id: episode.id,
        episode_id: episode.id,
        story_id: episode.story_id,
        story_title: story?.title || 'Untitled Story',
        author_id: story?.author_id || null,
        title: episode.title || 'Untitled Episode',
        episode_number: Number(episode.episode_number || 0),
        status: episode.status || 'published',
        ranking_visibility_status:
          episode.ranking_visibility_status || 'visible',
        ranking_hidden_reason: episode.ranking_hidden_reason || '',
        ranking_hidden_at: episode.ranking_hidden_at || null,
        ranking_hidden_by: episode.ranking_hidden_by || '',
        ranking_note: episode.ranking_note || '',
      },
    })
  } catch (error) {
    console.error('UPDATE EPISODE RANKING VISIBILITY ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to update episode ranking visibility',
      error: error.message,
    })
  }
}
