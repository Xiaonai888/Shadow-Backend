import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'

const FALLBACK_UNLOCK_RULES = {
  standard_free_first_episode_monthly_limit: 10,
  vip_free_first_episode_monthly_limit: 50,
  premium_free_first_episode_unlimited: true,
}

function publicAuthorPage(page) {
  if (!page) return null

  return {
    id: page.id,
    user_id: page.user_id,
    page_name: page.page_name,
    page_username: page.page_username,
    page_slug: page.page_slug,
    bio: page.bio,
    avatar_url: page.avatar_url,
    cover_url: page.cover_url,
    status: page.status,
    total_stories: page.total_stories,
    total_followers: page.total_followers,
    created_at: page.created_at,
    updated_at: page.updated_at,
  }
}

async function getStoryRankByViews(story) {
  const totalViews = Number(story?.total_views || 0)

  const { count, error } = await supabase
    .from('stories')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'published')
    .gt('total_views', totalViews)

  if (error) throw error

  return Number(count || 0) + 1
}

function publicStory(story, slides = [], authorPage = null, rankByViews = null) {
  if (!story) return null

  return {
    id: story.id,
    author_id: story.author_id,
    user_id: story.user_id,
    title: story.title,
    story_language: story.story_language,
    main_genre: story.main_genre,
    tags: story.tags || [],
    description: story.description,
    is_adult: story.is_adult,
    cover_url: story.cover_url,
    status: story.status,
    access_type: story.access_type || 'free',
    is_shadow_exclusive: Boolean(story.is_shadow_exclusive),
    exclusive_status: story.exclusive_status || 'none',
    exclusive_sections: story.exclusive_sections || [],
    update_days: story.update_days || [],
    total_episodes: story.total_episodes,
    total_views: story.total_views,
    rank_by_views: rankByViews,
    total_likes: story.total_likes,
    total_comments: story.total_comments,
    author_page: publicAuthorPage(authorPage),
    slides,
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

function publicStoryListItem(story) {
  if (!story) return null

  return {
    id: story.id,
    author_id: story.author_id,
    user_id: story.user_id,
    title: story.title,
    story_language: story.story_language,
    main_genre: story.main_genre,
    tags: story.tags || [],
    description: story.description,
    is_adult: story.is_adult,
    cover_url: story.cover_url,
    status: story.status,
    access_type: story.access_type || 'free',
    is_shadow_exclusive: Boolean(story.is_shadow_exclusive),
    exclusive_status: story.exclusive_status || 'none',
    exclusive_sections: story.exclusive_sections || [],
    update_days: story.update_days || [],
    total_episodes: story.total_episodes,
    total_views: story.total_views,
    rank_by_views: null,
    total_likes: story.total_likes,
    total_comments: story.total_comments,
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

function publicEpisodeListItem(episode) {
  if (!episode) return null

  return {
    id: episode.id,
    story_id: episode.story_id,
    title: episode.title,
    cover_url: episode.cover_url,
    is_adult: episode.is_adult,
    is_locked: Boolean(episode.is_locked),
    unlock_methods: episode.unlock_methods || [],
    status: episode.status,
    episode_number: episode.episode_number,
    character_count: episode.character_count,
    published_at: episode.published_at,
    created_at: episode.created_at,
    updated_at: episode.updated_at,
  }
}

function publicEpisode(episode) {
  if (!episode) return null

  return {
    id: episode.id,
    story_id: episode.story_id,
    title: episode.title,
    cover_url: episode.cover_url,
    content: episode.content,
    is_adult: episode.is_adult,
    is_locked: Boolean(episode.is_locked),
    unlock_methods: episode.unlock_methods || [],
    status: episode.status,
    episode_number: episode.episode_number,
    character_count: episode.character_count,
    published_at: episode.published_at,
    created_at: episode.created_at,
    updated_at: episode.updated_at,
  }
}

function getOptionalUser(req) {
  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

    if (!token || !process.env.JWT_SECRET) return null

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (decoded.type !== 'reader') return null

    return decoded
  } catch {
    return null
  }
}

function normalizeTier(value) {
  const tier = String(value || 'standard').trim().toLowerCase()

  if (tier === 'vip') return 'vip'
  if (tier === 'premium') return 'premium'

  return 'standard'
}

function getReaderTier(user) {
  return normalizeTier(user?.reader_tier || user?.subscription_tier || user?.membership_tier || user?.role)
}

function getMonthKey(date = new Date()) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')

  return `${year}-${month}`
}

function isFirstEpisode(episode) {
  return Number(episode?.episode_number || 0) <= 1
}

function isEpisodeFreeForReader(episode) {
  return !episode?.is_locked || isFirstEpisode(episode)
}

function getFreeFirstEpisodeLimit(rules, tier) {
  if (tier === 'premium' && rules.premium_free_first_episode_unlimited) return null
  if (tier === 'vip') return Number(rules.vip_free_first_episode_monthly_limit || FALLBACK_UNLOCK_RULES.vip_free_first_episode_monthly_limit)

  return Number(rules.standard_free_first_episode_monthly_limit || FALLBACK_UNLOCK_RULES.standard_free_first_episode_monthly_limit)
}

function normalizeLimit(value, fallback = 12, max = 48) {
  const number = Number(value)

  if (!Number.isFinite(number) || number <= 0) return fallback

  return Math.min(Math.floor(number), max)
}

function normalizeSearch(value) {
  return String(value || '').trim().replace(/[%_]/g, '\\$&')
}

function applyStorySort(query, sort) {
  if (sort === 'weekly_top' || sort === 'weekly' || sort === 'trending') {
    return query.order('total_views', { ascending: false }).order('updated_at', { ascending: false })
  }

  if (sort === 'popular') {
    return query.order('total_likes', { ascending: false }).order('total_views', { ascending: false }).order('updated_at', { ascending: false })
  }

  if (sort === 'likes') {
    return query.order('total_likes', { ascending: false }).order('updated_at', { ascending: false })
  }

  if (sort === 'updated') {
    return query.order('updated_at', { ascending: false })
  }

  if (sort === 'new' || sort === 'newest' || sort === 'latest') {
    return query.order('created_at', { ascending: false })
  }

  return query.order('created_at', { ascending: false })
}

async function getPlatformUnlockRules() {
  const { data, error } = await supabase
    .from('platform_unlock_rules')
    .select('*')
    .eq('id', 1)
    .maybeSingle()

  if (error || !data) return FALLBACK_UNLOCK_RULES

  return {
    ...FALLBACK_UNLOCK_RULES,
    ...data,
  }
}

async function getFreeFirstEpisodeUsage({ userId, monthKey }) {
  const { count, error } = await supabase
    .from('free_first_episode_reads')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('month_key', monthKey)

  if (error) throw error

  return Number(count || 0)
}

async function hasFreeFirstEpisodeRead({ userId, storyId, monthKey }) {
  const { data, error } = await supabase
    .from('free_first_episode_reads')
    .select('id')
    .eq('user_id', userId)
    .eq('story_id', storyId)
    .eq('month_key', monthKey)
    .maybeSingle()

  if (error) throw error

  return Boolean(data)
}

async function saveFreeFirstEpisodeRead({ userId, storyId, episodeId, monthKey, tier }) {
  const { error } = await supabase
    .from('free_first_episode_reads')
    .upsert(
      {
        user_id: userId,
        story_id: storyId,
        episode_id: episodeId,
        month_key: monthKey,
        reader_tier: tier,
      },
      {
        onConflict: 'user_id,story_id,month_key',
      }
    )

  if (error) throw error
}

async function checkAndSaveFreeFirstEpisodeAccess({ user, storyId, episode }) {
  if (!isFirstEpisode(episode)) {
    return {
      ok: true,
      counted: false,
      limit: null,
      used: null,
      remaining: null,
    }
  }

  if (!user?.user_id) {
    return {
      ok: false,
      code: 'LOGIN_REQUIRED',
      message: 'Please login to read this episode.',
      status: 401,
    }
  }

  const rules = await getPlatformUnlockRules()
  const tier = getReaderTier(user)
  const limit = getFreeFirstEpisodeLimit(rules, tier)
  const monthKey = getMonthKey()

  if (limit === null) {
    await saveFreeFirstEpisodeRead({
      userId: user.user_id,
      storyId,
      episodeId: episode.id,
      monthKey,
      tier,
    })

    return {
      ok: true,
      counted: true,
      limit: 'unlimited',
      used: null,
      remaining: 'unlimited',
      tier,
      month_key: monthKey,
    }
  }

  const alreadyReadThisStory = await hasFreeFirstEpisodeRead({
    userId: user.user_id,
    storyId,
    monthKey,
  })

  if (alreadyReadThisStory) {
    const used = await getFreeFirstEpisodeUsage({
      userId: user.user_id,
      monthKey,
    })

    return {
      ok: true,
      counted: false,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      tier,
      month_key: monthKey,
    }
  }

  const used = await getFreeFirstEpisodeUsage({
    userId: user.user_id,
    monthKey,
  })

  if (used >= limit) {
    return {
      ok: false,
      code: 'FREE_FIRST_EPISODE_MONTHLY_LIMIT_REACHED',
      message: `You reached your monthly free first-episode limit for ${tier} readers.`,
      status: 403,
      limit,
      used,
      remaining: 0,
      tier,
      month_key: monthKey,
    }
  }

  await saveFreeFirstEpisodeRead({
    userId: user.user_id,
    storyId,
    episodeId: episode.id,
    monthKey,
    tier,
  })

  return {
    ok: true,
    counted: true,
    limit,
    used: used + 1,
    remaining: Math.max(0, limit - used - 1),
    tier,
    month_key: monthKey,
  }
}

async function getViewCooldownHours() {
  const { data, error } = await supabase
    .from('platform_unlock_rules')
    .select('view_count_cooldown_hours')
    .eq('id', 1)
    .maybeSingle()

  if (error || !data) return 12

  return Number(data.view_count_cooldown_hours || 12)
}

async function recordEpisodeView({ userId, storyId, episodeId }) {
  if (!userId || !storyId || !episodeId) {
    return {
      counted: false,
      reason: 'missing_user_or_episode',
    }
  }

  const cooldownHours = await getViewCooldownHours()
  const now = new Date()
  const cooldownMs = cooldownHours * 60 * 60 * 1000

  const { data: oldLog, error: oldLogError } = await supabase
    .from('episode_view_logs')
    .select('id, last_counted_at')
    .eq('user_id', userId)
    .eq('episode_id', episodeId)
    .maybeSingle()

  if (oldLogError) throw oldLogError

  if (oldLog?.last_counted_at) {
    const lastCountedAt = new Date(oldLog.last_counted_at).getTime()

    if (now.getTime() - lastCountedAt < cooldownMs) {
      return {
        counted: false,
        reason: 'cooldown',
        cooldown_hours: cooldownHours,
      }
    }
  }

  const { error: upsertError } = await supabase
    .from('episode_view_logs')
    .upsert(
      {
        user_id: userId,
        story_id: storyId,
        episode_id: episodeId,
        last_counted_at: now.toISOString(),
      },
      {
        onConflict: 'user_id,episode_id',
      }
    )

  if (upsertError) throw upsertError

  const [{ data: story }, { data: episode }] = await Promise.all([
    supabase
      .from('stories')
      .select('total_views')
      .eq('id', storyId)
      .maybeSingle(),
    supabase
      .from('episodes')
      .select('total_views')
      .eq('id', episodeId)
      .maybeSingle(),
  ])

  await Promise.all([
    supabase
      .from('stories')
      .update({
        total_views: Number(story?.total_views || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', storyId),
    supabase
      .from('episodes')
      .update({
        total_views: Number(episode?.total_views || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', episodeId),
  ])

  return {
    counted: true,
    reason: 'counted',
    cooldown_hours: cooldownHours,
  }
}

async function hasActiveEpisodeUnlock({ userId, episodeId }) {
  if (!userId || !episodeId) return false

  const { data, error } = await supabase
    .from('episode_unlocks')
    .select('id, access_type, expires_at, unlock_status')
    .eq('user_id', userId)
    .eq('episode_id', episodeId)
    .eq('unlock_status', 'active')
    .maybeSingle()

  if (error) throw error
  if (!data) return false

  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    return false
  }

  return true
}

async function getAuthorPageById(authorId) {
  if (!authorId) return null

  const { data, error } = await supabase
    .from('author_pages')
    .select('*')
    .eq('id', authorId)
    .maybeSingle()

  if (error) throw error
  return data
}

async function getPublishedReadableStory(storyId) {
  const { data, error } = await supabase
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .eq('status', 'published')
    .maybeSingle()

  if (error) throw error
  return data
}

async function getApprovedExclusiveStory(storyId) {
  const { data, error } = await supabase
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .eq('status', 'published')
    .eq('is_shadow_exclusive', true)
    .eq('exclusive_status', 'approved')
    .maybeSingle()

  if (error) throw error
  return data
}

export async function getPublicStories(req, res) {
  try {
    const limit = normalizeLimit(req.query.limit, 10, 48)
    const genre = String(req.query.genre || '').trim()
    const language = String(req.query.language || '').trim()
    const sort = String(req.query.sort || 'latest').trim()
    const authorId = String(req.query.authorId || req.query.author_id || '').trim()
    const exclude = String(req.query.exclude || req.query.excludeId || req.query.exclude_id || '').trim()
    const search = normalizeSearch(req.query.q || req.query.search || req.query.keyword)

    let query = supabase
  .from('stories')
  .select('*')
  .eq('status', 'published')
  .or('is_shadow_exclusive.is.null,is_shadow_exclusive.eq.false')
  .limit(limit)

    if (genre) query = query.eq('main_genre', genre)
    if (language) query = query.eq('story_language', language)
    if (authorId) query = query.eq('author_id', authorId)
    if (exclude) query = query.neq('id', exclude)

    if (search) {
      query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%,main_genre.ilike.%${search}%`)
    }

    query = applyStorySort(query, sort)

    const { data, error } = await query

    if (error) throw error

    return res.status(200).json({
      ok: true,
      stories: (data || []).map(publicStoryListItem),
    })
  } catch (error) {
    console.error('GET PUBLIC STORIES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load stories',
      error: error.message,
    })
  }
}

export async function getPublicShadowExclusiveStories(req, res) {
  try {
    const limit = normalizeLimit(req.query.limit)
    const section = String(req.query.section || '').trim()
    const genre = String(req.query.genre || '').trim()
    const language = String(req.query.language || '').trim()
    const sort = String(req.query.sort || 'updated').trim()

    let query = supabase
      .from('stories')
      .select('*')
      .eq('status', 'published')
      .eq('is_shadow_exclusive', true)
      .eq('exclusive_status', 'approved')
      .limit(limit)

    if (section) query = query.contains('exclusive_sections', [section])
    if (genre) query = query.eq('main_genre', genre)
    if (language) query = query.eq('story_language', language)

    query = applyStorySort(query, sort)

    const { data, error } = await query

    if (error) throw error

    return res.status(200).json({
      ok: true,
      stories: (data || []).map(publicStoryListItem),
    })
  } catch (error) {
    console.error('GET PUBLIC SHADOW EXCLUSIVE STORIES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Shadow Exclusive stories',
      error: error.message,
    })
  }
}

export async function getPublicStoryById(req, res) {
  try {
    const { storyId } = req.params

    const story = await getPublishedReadableStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    if (story.is_shadow_exclusive && story.exclusive_status !== 'approved') {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const [{ data: slides, error: slidesError }, authorPage] = await Promise.all([
      supabase
        .from('story_carousel_slides')
        .select('*')
        .eq('story_id', storyId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true }),
      getAuthorPageById(story.author_id),
    ])

    if (slidesError) throw slidesError

    const rankByViews = await getStoryRankByViews(story)

return res.status(200).json({
  ok: true,
  story: publicStory(story, slides || [], authorPage, rankByViews),
})
  } catch (error) {
    console.error('GET PUBLIC STORY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load story',
      error: error.message,
    })
  }
}

export async function getPublicShadowExclusiveStoryById(req, res) {
  try {
    const { storyId } = req.params

    const story = await getApprovedExclusiveStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Shadow Exclusive story not found',
      })
    }

    const [{ data: slides, error: slidesError }, authorPage] = await Promise.all([
      supabase
        .from('story_carousel_slides')
        .select('*')
        .eq('story_id', storyId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true }),
      getAuthorPageById(story.author_id),
    ])

    if (slidesError) throw slidesError

    const rankByViews = await getStoryRankByViews(story)

    return res.status(200).json({
      ok: true,
      story: publicStory(story, slides || [], authorPage, rankByViews),
    })
  } catch (error) {
    console.error('GET PUBLIC SHADOW EXCLUSIVE STORY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Shadow Exclusive story',
      error: error.message,
    })
  }
}

export async function getPublicStoryEpisodes(req, res) {
  try {
    const { storyId } = req.params

    const story = await getPublishedReadableStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    if (story.is_shadow_exclusive && story.exclusive_status !== 'approved') {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const { data, error } = await supabase
      .from('episodes')
      .select('id, story_id, title, cover_url, is_adult, is_locked, unlock_methods, status, episode_number, character_count, published_at, created_at, updated_at')
      .eq('story_id', storyId)
      .eq('status', 'published')
      .order('episode_number', { ascending: true })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      episodes: (data || []).map(publicEpisodeListItem),
    })
  } catch (error) {
    console.error('GET PUBLIC STORY EPISODES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load episodes',
      error: error.message,
    })
  }
}

export async function getPublicEpisodeById(req, res) {
  try {
    const { storyId, episodeId } = req.params

    const story = await getPublishedReadableStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    if (story.is_shadow_exclusive && story.exclusive_status !== 'approved') {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const { data: episode, error } = await supabase
      .from('episodes')
      .select('*')
      .eq('id', episodeId)
      .eq('story_id', storyId)
      .eq('status', 'published')
      .maybeSingle()

    if (error) throw error

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    const user = getOptionalUser(req)
    const userId = user?.user_id || ''
    const freeEpisode = isEpisodeFreeForReader(episode)
    const activeUnlock = await hasActiveEpisodeUnlock({ userId, episodeId })

    if (isFirstEpisode(episode)) {
      const freeAccess = await checkAndSaveFreeFirstEpisodeAccess({
        user,
        storyId,
        episode,
      })

      if (!freeAccess.ok) {
        return res.status(freeAccess.status || 403).json({
          ok: false,
          code: freeAccess.code,
          message: freeAccess.message,
          locked: true,
          story: publicStory(story),
          episode: {
            ...publicEpisodeListItem(episode),
            content: '',
          },
          free_first_episode: {
            limit: freeAccess.limit,
            used: freeAccess.used,
            remaining: freeAccess.remaining,
            tier: freeAccess.tier,
            month_key: freeAccess.month_key,
          },
        })
      }

      const viewResult = await recordEpisodeView({
        userId: user.user_id,
        storyId,
        episodeId,
      })

      return res.status(200).json({
        ok: true,
        locked: false,
        story: publicStory(story),
        episode: publicEpisode(episode),
        free_first_episode: freeAccess,
        view: viewResult,
      })
    }

    const unlocked = freeEpisode || activeUnlock

    if (!unlocked) {
      return res.status(423).json({
        ok: false,
        code: 'EPISODE_LOCKED',
        message: 'This episode is locked',
        locked: true,
        story: publicStory(story),
        episode: {
          ...publicEpisodeListItem(episode),
          content: '',
        },
      })
    }

    const viewResult = await recordEpisodeView({
      userId,
      storyId,
      episodeId,
    })

    return res.status(200).json({
      ok: true,
      locked: false,
      story: publicStory(story),
      episode: publicEpisode(episode),
      view: viewResult,
    })
  } catch (error) {
    console.error('GET PUBLIC EPISODE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load episode',
      error: error.message,
    })
  }
}
