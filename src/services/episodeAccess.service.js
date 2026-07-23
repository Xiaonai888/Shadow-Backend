import { supabase } from '../config/supabase.js'

export const FREE_PUBLISHED_EPISODE_LIMIT = 5

function safeNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function safeTime(value) {
  const time = value ? new Date(value).getTime() : 0
  return Number.isFinite(time) ? time : 0
}

function episodeId(value) {
  return String(value?.id || value || '')
}

export function compareActiveEpisodeOrder(first, second) {
  const firstNumber = safeNumber(first?.episode_number, Number.MAX_SAFE_INTEGER)
  const secondNumber = safeNumber(second?.episode_number, Number.MAX_SAFE_INTEGER)

  if (firstNumber !== secondNumber) return firstNumber - secondNumber

  const firstCreated = safeTime(first?.created_at)
  const secondCreated = safeTime(second?.created_at)

  if (firstCreated !== secondCreated) return firstCreated - secondCreated

  return episodeId(first).localeCompare(episodeId(second))
}

export function comparePublishedEpisodeOrder(first, second) {
  const firstPublished = safeTime(first?.published_at || first?.created_at)
  const secondPublished = safeTime(second?.published_at || second?.created_at)

  if (firstPublished !== secondPublished) return firstPublished - secondPublished

  return compareActiveEpisodeOrder(first, second)
}

export function buildEpisodeAccess(
  episodes = [],
  now = Date.now(),
  freeLimit = FREE_PUBLISHED_EPISODE_LIMIT
) {
  const activeEpisodes = (Array.isArray(episodes) ? episodes : [])
    .filter((episode) => !episode?.deleted_at)
    .sort(compareActiveEpisodeOrder)

  const currentNumberById = new Map(
    activeEpisodes.map((episode, index) => [episodeId(episode), index + 1])
  )

  const publishedEpisodes = activeEpisodes
    .filter((episode) => {
      if (String(episode?.status || '').trim().toLowerCase() !== 'published') {
        return false
      }

      const publishedTime = safeTime(episode?.published_at || episode?.created_at)
      return !publishedTime || publishedTime <= now
    })
    .sort(comparePublishedEpisodeOrder)

  const publishedRankById = new Map(
    publishedEpisodes.map((episode, index) => [episodeId(episode), index + 1])
  )

  const freePublishedEpisodeIds = new Set(
    publishedEpisodes
      .slice(0, Math.max(0, Number(freeLimit || 0)))
      .map((episode) => episodeId(episode))
  )

  return {
    activeEpisodes,
    publishedEpisodes,
    currentNumberById,
    publishedRankById,
    freePublishedEpisodeIds,
  }
}

export function applyEpisodeAccess(episode, access = null) {
  if (!episode) return null

  const id = episodeId(episode)
  const currentNumber =
    access?.currentNumberById?.get(id) ??
    Math.max(1, safeNumber(episode.episode_number, 1))
  const publishedRank = access?.publishedRankById?.get(id) ?? null
  const isFreePublished = Boolean(
    access?.freePublishedEpisodeIds?.has(id)
  )

  return {
    ...episode,
    internal_episode_number: safeNumber(episode.episode_number, currentNumber),
    episode_number: currentNumber,
    published_rank: publishedRank,
    is_free_published: isFreePublished,
    is_locked: isFreePublished ? false : Boolean(episode.is_locked),
  }
}

export async function getStoryEpisodeAccess(
  storyId,
  now = Date.now(),
  freeLimit = FREE_PUBLISHED_EPISODE_LIMIT
) {
  const { data, error } = await supabase
    .from('episodes')
    .select(
      'id, story_id, episode_number, status, is_locked, published_at, created_at, deleted_at'
    )
    .eq('story_id', storyId)
    .is('deleted_at', null)
    .order('episode_number', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw error

  return buildEpisodeAccess(data || [], now, freeLimit)
}
