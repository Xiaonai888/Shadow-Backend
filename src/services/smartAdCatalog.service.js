import { supabase } from '../config/supabase.js'
import { evaluateSmartAdEligibility } from './smartAdEligibility.service.js'

const STORY_SELECT = [
  'id', 'title', 'story_type', 'story_status', 'status', 'deleted_at',
  'admin_visibility_status', 'is_adult', 'is_shadow_exclusive', 'exclusive_status',
  'author_id', 'description', 'main_genre', 'tags', 'cover_url',
  'total_views', 'total_likes', 'created_at',
].join(',')
const MAX_PAGE = 100

function check(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data || []
}

function shortText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function safeUrl(value) {
  const url = String(value || '').trim()
  return /^(https?:\/\/|\/[^/])/i.test(url) ? url : ''
}

function uniqueIds(values) {
  return [...new Set(values.filter(Boolean).map(String))]
}

export function toSmartAdCatalogRecord(story, episode, author, slide, eligibility) {
  return {
    story_id: String(story.id),
    title: shortText(story.title, 200),
    story_type: String(story.story_type || 'novel'),
    story_status: story.story_status || 'New',
    story_kind: eligibility.story_kind,
    genre: shortText(story.main_genre, 100),
    main_genre: shortText(story.main_genre, 100),
    tags: Array.isArray(story.tags) ? story.tags.filter((tag) => typeof tag === 'string').slice(0, 12) : [],
    episode_count: Number(episode.published_episode_count) || 0,
    total_views: Math.max(0, Number(story.total_views) || 0),
    total_likes: Math.max(0, Number(story.total_likes) || 0),
    author_id: story.author_id || null,
    author_name: shortText(author?.page_name || author?.page_username, 100),
    author_username: author?.page_username || '',
    author_avatar_url: safeUrl(author?.avatar_url),
    cover_url: safeUrl(story.cover_url),
    preview_image_url: safeUrl(slide?.image_url) || safeUrl(story.cover_url),
    description_preview: shortText(story.description, 360),
    last_episode_published_at: episode.last_episode_published_at,
    first_episode_id: String(episode.first_episode_id),
    fresh_30_days: eligibility.fresh_30_days,
    created_at: story.created_at || null,
  }
}

export async function enrichSmartAdCandidates(stories, { db = supabase, now = Date.now(), includeMedia = true } = {}) {
  if (!Array.isArray(stories) || !stories.length) return []
  if (stories.length > MAX_PAGE) throw new RangeError('Smart Ad enrichment is limited to 100 stories')
  const storyIds = uniqueIds(stories.map((story) => story.id))
  const authorIds = uniqueIds(stories.map((story) => story.author_id))
  const [episodeResult, slidesResult, authorsResult] = await Promise.all([
    db.rpc('smart_ad_episode_summaries_v1', { p_story_ids: storyIds }),
    includeMedia
      ? db.from('story_carousel_slides').select('story_id,image_url,sort_order')
        .in('story_id', storyIds).eq('is_active', true).order('sort_order', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    includeMedia && authorIds.length
      ? db.from('author_pages').select('id,page_name,page_username,avatar_url').in('id', authorIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  const episodes = check(episodeResult, 'Smart Ad episode summaries')
  const slides = check(slidesResult, 'Smart Ad slide images')
  const authors = check(authorsResult, 'Smart Ad author information')
  const episodeMap = new Map(episodes.map((entry) => [String(entry.story_id), entry]))
  const authorMap = new Map(authors.map((entry) => [String(entry.id), entry]))
  const slideMap = new Map()
  for (const slide of slides) {
    const key = String(slide.story_id)
    if (!slideMap.has(key) && slide.image_url) slideMap.set(key, slide)
  }
  return stories.flatMap((story) => {
    const summary = episodeMap.get(String(story.id))
    const decision = evaluateSmartAdEligibility(story, summary, now)
    if (!decision.eligible) return []
    return [toSmartAdCatalogRecord(
      story, summary, authorMap.get(String(story.author_id)), slideMap.get(String(story.id)), decision,
    )]
  })
}

export async function readSmartAdCandidatePage({
  offset = 0, limit = MAX_PAGE, db = supabase, now = Date.now(), includeMedia = false,
} = {}) {
  const start = Math.max(0, Math.floor(Number(offset) || 0))
  const pageSize = Math.max(1, Math.min(MAX_PAGE, Math.floor(Number(limit) || MAX_PAGE)))
  // Only fetch the metadata required to decide eligibility and display an Ad.
  // More restrictive rules (published episode count/dates) are validated in bulk.
  const result = await db.from('stories').select(STORY_SELECT)
    .eq('status', 'published').is('deleted_at', null)
    .or('admin_visibility_status.is.null,admin_visibility_status.eq.active')
    .or('is_adult.is.null,is_adult.eq.false')
    .or('is_shadow_exclusive.is.null,is_shadow_exclusive.eq.false,exclusive_status.eq.approved')
    .in('story_type', ['novel', 'short_story', 'short', 'short_novel'])
    .order('total_views', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
    .range(start, start + pageSize - 1)
  const stories = check(result, 'Smart Ad story candidates')
  return {
    rows_read: stories.length,
    records: await enrichSmartAdCandidates(stories, { db, now, includeMedia }),
    next_offset: stories.length === pageSize ? start + pageSize : null,
  }
}

export async function readSmartAdCatalogByIds(storyIds, { db = supabase, now = Date.now(), includeMedia = true } = {}) {
  const ids = uniqueIds(Array.isArray(storyIds) ? storyIds : [])
  if (ids.length > MAX_PAGE) throw new RangeError('Smart Ad catalog reads are limited to 100 IDs')
  if (!ids.length) return []
  const stories = check(await db.from('stories').select(STORY_SELECT).in('id', ids), 'Smart Ad story lookup')
  const records = await enrichSmartAdCandidates(stories, { db, now, includeMedia })
  const map = new Map(records.map((record) => [record.story_id, record]))
  return ids.map((id) => map.get(id)).filter(Boolean)
}
