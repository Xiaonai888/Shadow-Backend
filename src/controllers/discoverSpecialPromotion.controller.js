import { supabase } from '../config/supabase.js'
import { getStoryEpisodeAccess } from '../services/episodeAccess.service.js'

const CACHE_MS = 5 * 60 * 1000
const MIN_LOCKED_EPISODES = 5
const CANDIDATE_LIMIT = 36
const PRIORITY_GROUP_SIZE = 12
const DEFAULT_DIAMONDS_PER_EPISODE = 10

let cache = { promotion: null, expiresAt: 0 }
let pending = null

function shuffle(items) {
  const result = [...items]

  for (let index = result.length - 1; index > 0; index -= 1) {
    const next = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[next]] = [result[next], result[index]]
  }

  return result
}

async function selectPromotion() {
  const { data: stories, error: storiesError } = await supabase
    .from('stories')
    .select('id, author_id, title, description, cover_url, total_episodes')
    .eq('status', 'published')
    .is('deleted_at', null)
    .gte('total_episodes', MIN_LOCKED_EPISODES + 5)
    .or('admin_visibility_status.is.null,admin_visibility_status.eq.active')
    .or('is_adult.is.null,is_adult.eq.false')
    .or('is_shadow_exclusive.is.null,is_shadow_exclusive.eq.false')
    .order('total_episodes', { ascending: false })
    .limit(CANDIDATE_LIMIT)

  if (storiesError) throw storiesError

  const candidates = (stories || []).filter(
    (story) => story.id && story.author_id && story.title && story.cover_url
  )

  if (!candidates.length) return null

  const authorIds = [...new Set(candidates.map((story) => story.author_id))]
  const [authorsResult, rulesResult] = await Promise.all([
    supabase
      .from('author_pages')
      .select('id, avatar_url')
      .in('id', authorIds)
      .eq('status', 'active')
      .or('admin_status.is.null,admin_status.eq.active'),
    supabase
      .from('platform_unlock_rules')
      .select('diamond_per_episode')
      .eq('id', 1)
      .maybeSingle(),
  ])

  if (authorsResult.error) throw authorsResult.error

  const authors = new Map(
    (authorsResult.data || []).map((author) => [String(author.id), author])
  )
  const basePrice = Number(rulesResult.data?.diamond_per_episode)
  const diamondsPerEpisode = Number.isSafeInteger(basePrice) && basePrice >= 2
    ? basePrice
    : rulesResult.data
      ? 0
      : DEFAULT_DIAMONDS_PER_EPISODE

  if (!Number.isSafeInteger(diamondsPerEpisode) || diamondsPerEpisode < 2) {
    return null
  }

  const eligibleStories = candidates.filter(
    (story) => authors.has(String(story.author_id))
  )

  for (let start = 0; start < eligibleStories.length; start += PRIORITY_GROUP_SIZE) {
    const group = shuffle(eligibleStories.slice(start, start + PRIORITY_GROUP_SIZE))

    for (const story of group) {
      const access = await getStoryEpisodeAccess(story.id)
      const lockedEpisodes = access.publishedEpisodes.filter(
        (episode) => episode.is_locked &&
          !access.freePublishedEpisodeIds.has(String(episode.id))
      )

      if (lockedEpisodes.length < MIN_LOCKED_EPISODES) continue

      const originalPrice = lockedEpisodes.length * diamondsPerEpisode
      const discountedPrice = Math.ceil(originalPrice / 2)

      if (!Number.isSafeInteger(originalPrice) || discountedPrice < lockedEpisodes.length) {
        continue
      }
      const author = authors.get(String(story.author_id))

      return {
        id: `special-${story.id}`,
        story_id: story.id,
        story_title: story.title,
        description: story.description || '',
        cover_url: story.cover_url,
        profile_image_url: author.avatar_url || story.cover_url,
        locked_episode_count: lockedEpisodes.length,
        total_episodes: access.publishedEpisodes.length,
        original_price_diamonds: originalPrice,
        discounted_price_diamonds: discountedPrice,
        discount_percent: 50,
      }
    }
  }

  return null
}

export async function getCurrentDiscoverSpecialPromotion() {
  if (Date.now() < cache.expiresAt) {
    return cache.promotion
  }

  if (!pending) {
    pending = selectPromotion()
      .then((promotion) => {
        cache = { promotion, expiresAt: Date.now() + CACHE_MS }
        return promotion
      })
      .finally(() => {
        pending = null
      })
  }

  return pending
}

export async function getActiveDiscoverSpecialPromotion(req, res) {
  try {
    const promotion = await getCurrentDiscoverSpecialPromotion()

    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=60')
    return res.status(200).json({ ok: true, promotion })
  } catch (error) {
    console.error('GET DISCOVER SPECIAL PROMOTION ERROR:', error)
    return res.status(503).json({
      ok: false,
      message: 'Special promotion is temporarily unavailable',
    })
  }
}
