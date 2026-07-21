import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import { incrementAuthorPageAnalytics } from '../services/authorAnalytics.service.js'

const FALLBACK_UNLOCK_RULES = {
  standard_free_first_episode_monthly_limit: 10,
  vip_free_first_episode_monthly_limit: 50,
  premium_free_first_episode_unlimited: true,
}

const WAIT_FREE_DAYS = 7
const WAIT_FREE_MS = WAIT_FREE_DAYS * 24 * 60 * 60 * 1000

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
    .is('deleted_at', null)
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
author_page: publicAuthorPage(story.author_page),
title: story.title,
    story_language: story.story_language,
    main_genre: story.main_genre,
    story_status: story.story_status || 'New',
    tags: story.tags || [],
    description: story.description,
    is_adult: story.is_adult,
    cover_url: story.cover_url,
landscape_thumbnail_url: story.landscape_thumbnail_url || null,
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

function isStoryCompleted(story) {
  return String(story?.story_status || '').trim().toLowerCase() === 'completed'
}

function getEpisodePublishedTime(episode) {
  const value = episode?.published_at || episode?.created_at
  const time = value ? new Date(value).getTime() : 0

  return Number.isFinite(time) ? time : 0
}

function isPublicEpisode(episode, now = Date.now()) {
  const status = String(episode?.status || 'published').trim().toLowerCase()

  if (status && status !== 'published') return false

  const publishedTime = getEpisodePublishedTime(episode)

  if (publishedTime && publishedTime > now) return false

  return true
}

function compareEpisodeOrder(a, b) {
  const firstNumber = Number(a?.episode_number || 0)
  const secondNumber = Number(b?.episode_number || 0)

  if (firstNumber !== secondNumber) return firstNumber - secondNumber

  const firstTime = getEpisodePublishedTime(a) || new Date(a?.created_at || 0).getTime()
  const secondTime = getEpisodePublishedTime(b) || new Date(b?.created_at || 0).getTime()

  if (firstTime !== secondTime) return firstTime - secondTime

  return String(a?.id || '').localeCompare(String(b?.id || ''))
}

function getFirstVisibleEpisodeId(episodes = [], now = Date.now()) {
  const visibleEpisodes = (episodes || [])
    .filter((episode) => isPublicEpisode(episode, now))
    .sort(compareEpisodeOrder)

  return visibleEpisodes[0]?.id || null
}

async function getFirstVisibleEpisodeIdForStory(storyId) {
  const { data, error } = await supabase
    .from('episodes')
    .select('id, episode_number, published_at, created_at, status')
    .eq('story_id', storyId)
    .eq('status', 'published')
    .is('deleted_at', null)
    .order('episode_number', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw error

  return getFirstVisibleEpisodeId(data || [])
}

function getPositiveInteger(value, fallback, max = 365) {
  const number = Number(value)

  if (!Number.isFinite(number) || number <= 0) return fallback

  return Math.min(Math.floor(number), max)
}

function getAutoFreeOldEpisodeLimit(story, totalVisibleEpisodes = null) {
  const totalEpisodes = Number(totalVisibleEpisodes ?? story?.total_episodes ?? 0)
  const maxEpisodes = getPositiveInteger(story?.auto_free_max_episodes, 5, 100)
  const maxPercent = getPositiveInteger(story?.auto_free_max_percent, 10, 100)
  const percentLimit = Math.ceil(totalEpisodes * (maxPercent / 100))

  return Math.max(0, Math.min(maxEpisodes, percentLimit))
}

function isOldEnoughForAutoFree(episode, story, now = Date.now()) {
  if (!story?.auto_free_old_episodes_enabled) return false
  if (!episode?.is_locked) return false

  const publishedTime = getEpisodePublishedTime(episode)

  if (!publishedTime) return false

  const freeAfterDays = getPositiveInteger(story?.auto_free_after_days, 30, 365)
  const freeAfterMs = freeAfterDays * 24 * 60 * 60 * 1000

  return now - publishedTime >= freeAfterMs
}

function getAutoFreeVisibleEpisodeIds(visibleEpisodes = [], story, now = Date.now()) {
  if (!story?.auto_free_old_episodes_enabled) return new Set()

  const orderedEpisodes = [...(visibleEpisodes || [])]
    .filter((episode) => isPublicEpisode(episode, now))
    .sort(compareEpisodeOrder)

  const limit = getAutoFreeOldEpisodeLimit(story, orderedEpisodes.length)

  if (limit <= 0) return new Set()

  return new Set(
    orderedEpisodes
      .slice(5)
      .filter((episode) => isOldEnoughForAutoFree(episode, story, now))
      .slice(0, limit)
      .map((episode) => episode.id)
  )
}

async function getAutoFreeVisibleEpisodeIdsForStory(storyId, story, now = Date.now()) {
  const { data, error } = await supabase
    .from('episodes')
    .select('id, episode_number, is_locked, published_at, created_at, status')
    .eq('story_id', storyId)
    .eq('status', 'published')
    .is('deleted_at', null)
    .order('episode_number', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw error

  return getAutoFreeVisibleEpisodeIds(data || [], story, now)
}

function isWaitFreeEpisode(episode, now = Date.now()) {
  const episodeNumber = Number(episode?.episode_number || 0)
  const publishedTime = getEpisodePublishedTime(episode)

  if (episodeNumber <= 1) return false
  if (!episode?.is_locked) return false
  if (!publishedTime) return false

  return now - publishedTime >= 0 && now - publishedTime < WAIT_FREE_MS
}

function isFreeEpisode(episode, firstVisibleEpisodeId = null) {
  const episodeNumber = Number(episode?.episode_number || 0)

  if (firstVisibleEpisodeId && episode?.id === firstVisibleEpisodeId) return true
  if (episodeNumber <= 5) return true
  if (!episode?.is_locked) return true

  return false
}

function isEpisodeFreeForReader(
  episode,
  story,
  now = Date.now(),
  firstVisibleEpisodeId = null,
  autoFreeEpisodeIds = new Set()
) {
  return isFreeEpisode(episode, firstVisibleEpisodeId) || autoFreeEpisodeIds.has(episode?.id)
}


async function getStoryAccessSummaries(storyIds = []) {
  const ids = [...new Set(storyIds.filter(Boolean))]

  if (!ids.length) return new Map()

  const summaries = new Map(
    ids.map((id) => [
      id,
      {
        has_wait_free_episode: false,
        has_free_episode: false,
        wait_free_episode_count: 0,
        free_episode_count: 0,
      },
    ])
  )

  const { data, error } = await supabase
    .from('episodes')
    .select('id, story_id, episode_number, is_locked, published_at, created_at, status')
    .in('story_id', ids)

  if (error) throw error

  const now = Date.now()

    const firstVisibleEpisodeIds = new Map()

;(data || []).forEach((episode) => {
  if (!isPublicEpisode(episode, now)) return

  const current = firstVisibleEpisodeIds.get(episode.story_id)

  if (!current || compareEpisodeOrder(episode, current) < 0) {
    firstVisibleEpisodeIds.set(episode.story_id, episode)
  }
})

  ;(data || []).forEach((episode) => {
    if (!isPublicEpisode(episode, now)) return

    const summary = summaries.get(episode.story_id)

    if (!summary) return

    if (isWaitFreeEpisode(episode, now)) {
      summary.has_wait_free_episode = true
      summary.wait_free_episode_count += 1
    }

    if (isFreeEpisode(episode, firstVisibleEpisodeIds.get(episode.story_id)?.id || null)) {
      summary.has_free_episode = true
      summary.free_episode_count += 1
    }
  })

  return summaries
}

function publicStoryListItem(story, accessSummary = null) {
  if (!story) return null

  return {
    id: story.id,
author_id: story.author_id,
user_id: story.user_id,
author_page: publicAuthorPage(story.author_page),
title: story.title,
    story_language: story.story_language,
    main_genre: story.main_genre,
    story_status: story.story_status || 'New',
    tags: story.tags || [],
    description: story.description,
    is_adult: story.is_adult,
    cover_url: story.cover_url,
landscape_thumbnail_url: story.landscape_thumbnail_url || null,
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
    has_wait_free_episode: Boolean(accessSummary?.has_wait_free_episode),
    has_free_episode: Boolean(accessSummary?.has_free_episode),
    is_completed: isStoryCompleted(story),
    wait_free_episode_count: Number(accessSummary?.wait_free_episode_count || 0),
    free_episode_count: Number(accessSummary?.free_episode_count || 0),
    created_at: story.created_at,
    updated_at: story.updated_at,
  }
}

function publicEpisodeListItem(episode, story = null, firstVisibleEpisodeId = null, autoFreeEpisodeIds = new Set()) {
  if (!episode) return null

  const freeForReader = story
    ? isEpisodeFreeForReader(episode, story, Date.now(), firstVisibleEpisodeId, autoFreeEpisodeIds)
    : isFreeEpisode(episode, firstVisibleEpisodeId)

  return {
    id: episode.id,
    story_id: episode.story_id,
    title: episode.title,
    cover_url: episode.cover_url,
    is_adult: episode.is_adult,
    is_locked: !freeForReader,
    unlock_methods: episode.unlock_methods || [],
    status: episode.status,
    episode_number: episode.episode_number,
    character_count: episode.character_count,
    published_at: episode.published_at,
    created_at: episode.created_at,
    updated_at: episode.updated_at,
  }
}

function publicEpisode(
  episode,
  story = null,
  unlocked = false,
  firstVisibleEpisodeId = null,
  autoFreeEpisodeIds = new Set()
) {
  if (!episode) return null

  const freeForReader = story
    ? isEpisodeFreeForReader(episode, story, Date.now(), firstVisibleEpisodeId, autoFreeEpisodeIds)
    : isFreeEpisode(episode, firstVisibleEpisodeId)
  const accessible = Boolean(unlocked || freeForReader)

  return {
    id: episode.id,
    story_id: episode.story_id,
    title: episode.title,
    cover_url: episode.cover_url,
    content: episode.content,
    is_adult: episode.is_adult,
    is_locked: !accessible,
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

function isDiscoverMoreSort(sort) {
  return ['discover_more', 'discover-more', 'discover', 'hidden_gems', 'hidden-gems'].includes(String(sort || '').trim().toLowerCase())
}

function getWeekSeed(date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1)
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())

  return Math.floor((today - start) / (7 * 24 * 60 * 60 * 1000))
}

function getRotationScore(story, seed) {
  const text = `${story.id}-${seed}`
  let hash = 0

  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 1000000007
  }

  return hash
}

function pickDiscoverMoreStories(stories, limit) {
  const seed = getWeekSeed()

  return [...stories]
    .sort((a, b) => getRotationScore(a, seed) - getRotationScore(b, seed))
    .slice(0, limit)
}

function applyStorySort(query, sort) {
  if (sort === 'weekly_top' || sort === 'weekly' || sort === 'trending') {
    return query.order('total_views', { ascending: false }).order('updated_at', { ascending: false })
  }

    if (isDiscoverMoreSort(sort)) {
    return query.order('total_views', { ascending: true }).order('updated_at', { ascending: false })
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
    .is('deleted_at', null)
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
    .is('deleted_at', null)
    .eq('is_shadow_exclusive', true)
    .eq('exclusive_status', 'approved')
    .maybeSingle()

  if (error) throw error
  return data
}

export async function getPublicStories(req, res) {
  try {
    const limit = normalizeLimit(req.query.limit, 10, 100)
    const genre = String(req.query.genre || '').trim()
    const language = String(req.query.language || '').trim()
    const sort = String(req.query.sort || 'latest').trim()
    const queryLimit = isDiscoverMoreSort(sort) ? Math.min(Math.max(limit * 8, 24), 48) : limit
    const authorId = String(req.query.authorId || req.query.author_id || '').trim()
    const exclude = String(req.query.exclude || req.query.excludeId || req.query.exclude_id || '').trim()
    const search = normalizeSearch(req.query.q || req.query.search || req.query.keyword)

    let query = supabase
  .from('stories')
  .select('*')
  .eq('status', 'published')
  .is('deleted_at', null)
  .or('is_shadow_exclusive.is.null,is_shadow_exclusive.eq.false')
  .limit(queryLimit)

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

    const stories = isDiscoverMoreSort(sort) ? pickDiscoverMoreStories(data || [], limit) : data || []
    const authorIds = [
      ...new Set(stories.map((story) => story.author_id).filter(Boolean)),
    ]

    let authorPages = []

    if (authorIds.length) {
      const { data: authorPageRows, error: authorPagesError } = await supabase
        .from('author_pages')
        .select('*')
        .in('id', authorIds)

      if (authorPagesError) throw authorPagesError

      authorPages = authorPageRows || []
    }

    const authorPageMap = new Map(
      authorPages.map((page) => [String(page.id), page])
    )

    const accessSummaries = await getStoryAccessSummaries(
      stories.map((story) => story.id)
    )

    return res.status(200).json({
      ok: true,
      stories: stories.map((story) =>
        publicStoryListItem(
          {
            ...story,
            author_page:
              authorPageMap.get(String(story.author_id)) || null,
          },
          accessSummaries.get(story.id)
        )
      ),
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
    const storyStatus = String(req.query.story_status || req.query.storyStatus || '').trim()
    const sort = String(req.query.sort || 'latest').trim()
    const authorId = String(req.query.authorId || req.query.author_id || '').trim()

    let query = supabase
      .from('stories')
      .select('*')
      .eq('status', 'published')
      .is('deleted_at', null)
      .eq('is_shadow_exclusive', true)
      .eq('exclusive_status', 'approved')
      .limit(limit)

    if (genre) query = query.eq('main_genre', genre)
    if (language) query = query.eq('story_language', language)
    if (storyStatus) query = query.eq('story_status', storyStatus)
    if (authorId) query = query.eq('author_id', authorId)

    query = applyStorySort(query, sort)

    const { data, error } = await query

    if (error) throw error

    const stories = data || []
    const accessSummaries = await getStoryAccessSummaries(
      stories.map((story) => story.id)
    )

    return res.status(200).json({
      ok: true,
      stories: stories.map((story) =>
        publicStoryListItem(story, accessSummaries.get(story.id))
      ),
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
      .is('deleted_at', null)
      .order('episode_number', { ascending: true })
      .order('created_at', { ascending: true })

    if (error) throw error

    const now = Date.now()
    const visibleEpisodes = (data || []).filter((episode) => isPublicEpisode(episode, now))
    const firstVisibleEpisodeId = getFirstVisibleEpisodeId(visibleEpisodes, now)
    const autoFreeEpisodeIds = getAutoFreeVisibleEpisodeIds(visibleEpisodes, story, now)

return res.status(200).json({
  ok: true,
  first_visible_episode_id: firstVisibleEpisodeId,
  auto_free_episode_ids: [...autoFreeEpisodeIds],
  episodes: visibleEpisodes.map((episode) =>
    publicEpisodeListItem(episode, story, firstVisibleEpisodeId, autoFreeEpisodeIds)
  ),
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
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error

    if (!episode || !isPublicEpisode(episode)) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    const user = getOptionalUser(req)
    const userId = user?.user_id || ''
    const now = Date.now()
    const firstVisibleEpisodeId = await getFirstVisibleEpisodeIdForStory(storyId)
    const autoFreeEpisodeIds = await getAutoFreeVisibleEpisodeIdsForStory(storyId, story, now)
    const freeEpisode = isEpisodeFreeForReader(episode, story, now, firstVisibleEpisodeId, autoFreeEpisodeIds)
    const activeUnlock = await hasActiveEpisodeUnlock({ userId, episodeId })
    const unlocked = freeEpisode || activeUnlock

    if (!unlocked) {
      return res.status(423).json({
        ok: false,
        code: 'EPISODE_LOCKED',
        message: 'This episode is locked',
        locked: true,
        story: publicStory(story),
        episode: {
          ...publicEpisodeListItem(episode, story, firstVisibleEpisodeId, autoFreeEpisodeIds),
          content: '',
        },
      })
    }

    return res.status(200).json({
      ok: true,
      locked: false,
      first_visible_episode_id: firstVisibleEpisodeId,
      story: publicStory(story),
      episode: publicEpisode(episode, story, unlocked, firstVisibleEpisodeId, autoFreeEpisodeIds),
      free_first_episode: firstVisibleEpisodeId && episode.id === firstVisibleEpisodeId
        ? {
            counted: false,
            limit: 'unlimited',
            used: null,
            remaining: 'unlimited',
            tier: getReaderTier(user),
            month_key: getMonthKey(),
          }
        : null,
      view: {
        counted: false,
        reason: 'qualified_view_required',
      },
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

export async function countQualifiedEpisodeView(req, res) {
  try {
    const { storyId, episodeId } = req.params
    const user = getOptionalUser(req)

    if (!user?.user_id) {
      return res.status(401).json({
        ok: false,
        message: 'Please login to count view.',
      })
    }

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
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error

    if (!episode || !isPublicEpisode(episode)) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    const now = Date.now()
    const firstVisibleEpisodeId = await getFirstVisibleEpisodeIdForStory(storyId)
    const autoFreeEpisodeIds = await getAutoFreeVisibleEpisodeIdsForStory(storyId, story, now)
    const freeEpisode = isEpisodeFreeForReader(episode, story, now, firstVisibleEpisodeId, autoFreeEpisodeIds)
    const activeUnlock = await hasActiveEpisodeUnlock({
      userId: user.user_id,
      episodeId,
    })

    if (!freeEpisode && !activeUnlock) {
      return res.status(423).json({
        ok: false,
        code: 'EPISODE_LOCKED',
        message: 'This episode is locked',
      })
    }

    const viewResult = await recordEpisodeView({
  userId: user.user_id,
  storyId,
  episodeId,
})

if (viewResult.counted && story.author_id) {
  await incrementAuthorPageAnalytics(
    story.author_id,
    'story_reads'
  )
}

return res.status(200).json({
  ok: true,
  view: viewResult,
})
  } catch (error) {
    console.error('COUNT QUALIFIED EPISODE VIEW ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to count view',
      error: error.message,
    })
  }
}
