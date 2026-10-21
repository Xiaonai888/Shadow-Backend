import { supabase } from '../config/supabase.js'
import {
  getReaderAgeAccess,
  isStoryVisibleToReader,
} from '../services/storyAgeAccess.service.js'

const BATCH_SIZE = 100
const PAGE_SIZE = 500
const CAMBODIA_UTC_OFFSET = 7 * 60 * 60 * 1000

function startOfToday() {
  const now = Date.now()
  const localDay = Math.floor((now + CAMBODIA_UTC_OFFSET) / 86400000)
  return new Date(localDay * 86400000 - CAMBODIA_UTC_OFFSET).toISOString()
}

async function loadSubscriptions(userId) {
  const rows = []

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('reader_subscriptions')
      .select('story_id, story:stories(id, status, deleted_at, is_adult)')
      .eq('user_id', userId)
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) throw error
    rows.push(...(data || []))
    if ((data || []).length < PAGE_SIZE) break
  }

  return rows
}

async function loadAllRows(queryFactory) {
  const rows = []

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await queryFactory()
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) throw error
    rows.push(...(data || []))
    if ((data || []).length < PAGE_SIZE) break
  }

  return rows
}

async function findUnreadStories(storyIds, userId, todayStart, now) {
  const unread = new Set()

  for (let i = 0; i < storyIds.length; i += BATCH_SIZE) {
    const ids = storyIds.slice(i, i + BATCH_SIZE)
    const [episodes, progress] = await Promise.all([
      loadAllRows(() => supabase
        .from('episodes')
        .select('story_id, episode_number, published_at, created_at')
        .in('story_id', ids)
        .eq('status', 'published')
        .is('deleted_at', null)
        .or(
          `and(published_at.gte.${todayStart},published_at.lte.${now}),and(published_at.is.null,created_at.gte.${todayStart},created_at.lte.${now})`
        )),
      loadAllRows(() => supabase
        .from('reading_progress')
        .select('story_id, episode_number, last_read_at')
        .eq('user_id', userId)
        .in('story_id', ids)),
    ])

    const progressByStory = new Map(
      progress.map((row) => [String(row.story_id), row])
    )

    for (const episode of episodes) {
      const storyId = String(episode.story_id)
      if (unread.has(storyId)) continue

      const lastRead = progressByStory.get(storyId)
      const episodeNumber = Number(episode.episode_number || 0)
      const lastEpisodeNumber = Number(lastRead?.episode_number || 0)
      const publishedAt = Date.parse(episode.published_at || episode.created_at)
      const lastReadAt = Date.parse(lastRead?.last_read_at || '')

      if (
        !lastRead ||
        episodeNumber > lastEpisodeNumber ||
        (episodeNumber === lastEpisodeNumber &&
          (!Number.isFinite(lastReadAt) || lastReadAt < publishedAt))
      ) {
        unread.add(storyId)
      }
    }
  }

  return unread.size
}

export async function getTodayUnreadSubscribedStoryCount(req, res) {
  try {
    const userId = String(req.user?.user_id || req.user?.id || '')
    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const subscriptions = await loadSubscriptions(userId)
    const candidateStories = subscriptions
      .map((item) => item.story)
      .filter((story) => story && story.status === 'published' && !story.deleted_at)

    const ageAccess = candidateStories.some((story) => story.is_adult)
      ? await getReaderAgeAccess(req)
      : null

    const storyIds = [...new Set(candidateStories
      .filter((story) => isStoryVisibleToReader(story, ageAccess))
      .map((story) => String(story.id)))]

    const count = storyIds.length
      ? await findUnreadStories(storyIds, userId, startOfToday(), new Date().toISOString())
      : 0

    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, unread_count: count })
  } catch (error) {
    console.error('GET SUBSCRIBED STORIES UNREAD TODAY ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to count unread subscribed stories',
    })
  }
}
