import { supabase } from '../config/supabase.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function restoreAuthorEpisodeFromTrash(req, res) {
  try {
    const userId = String(req.user?.user_id || '').trim()
    const storyId = String(req.params.storyId || '').trim()
    const episodeId = String(req.params.episodeId || '').trim()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!UUID_PATTERN.test(storyId) || !UUID_PATTERN.test(episodeId)) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_ID',
        message: 'Invalid story or episode ID',
      })
    }

    const { data, error } = await supabase.rpc('restore_author_episode_v1', {
      p_story_id: storyId,
      p_episode_id: episodeId,
      p_user_id: userId,
    })

    if (error) {
      console.error('RESTORE AUTHOR EPISODE RPC ERROR:', error)
      return res.status(500).json({
        ok: false,
        code: 'RESTORE_DATABASE_ERROR',
        message: 'Failed to restore episode',
      })
    }

    const result = Array.isArray(data) ? data[0] : data

    if (!result || typeof result !== 'object') {
      return res.status(502).json({
        ok: false,
        code: 'INVALID_RESTORE_RESPONSE',
        message: 'Invalid restore response',
      })
    }

    if (result.ok !== true) {
      const statusByCode = {
        STORY_NOT_AVAILABLE: 404,
        EPISODE_NOT_FOUND: 404,
        RESTORE_EXPIRED: 410,
        EPISODE_NUMBER_CONFLICT: 409,
      }

      return res.status(statusByCode[result.code] || 400).json({
        ok: false,
        code: result.code || 'RESTORE_FAILED',
        message: result.message || 'Failed to restore episode',
      })
    }

    return res.status(200).json(result)
  } catch (error) {
    console.error('RESTORE AUTHOR EPISODE ERROR:', error)
    return res.status(500).json({
      ok: false,
      code: 'RESTORE_SERVER_ERROR',
      message: 'Failed to restore episode',
    })
  }
}

// Read-only trash listing for the current author. Pagination avoids silently
// dropping episodes when an author has more than 100 deleted episodes.
export async function getAuthorDeletedEpisodes(req, res) {
  try {
    const userId = String(req.user?.user_id || '').trim()
    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const rawPage = Number(req.query?.page)
    const rawLimit = Number(req.query?.limit)
    const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 100000) : 1
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 100
    const start = (page - 1) * limit
    const nowMs = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const now = new Date(nowMs).toISOString()
    const cutoff = new Date(nowMs - 30 * dayMs).toISOString()

    const { data: deletedRows, error: episodeError } = await supabase
      .from('episodes')
      .select('id, story_id, title, episode_number, deleted_at, delete_expires_at')
      .eq('user_id', userId)
      .not('deleted_at', 'is', null)
      .gte('deleted_at', cutoff)
      .gt('delete_expires_at', now)
      .order('deleted_at', { ascending: false })
      .order('id', { ascending: false })
      .range(start, start + limit)

    if (episodeError) throw episodeError

    const rows = deletedRows || []
    const hasMore = rows.length > limit
    const selected = rows.slice(0, limit)
    const storyIds = [...new Set(selected.map((episode) => episode.story_id).filter(Boolean))]

    let stories = []
    if (storyIds.length) {
      const { data, error } = await supabase
        .from('stories')
        .select('id, title, cover_url, deleted_at, delete_expires_at')
        .eq('user_id', userId)
        .in('id', storyIds)

      if (error) throw error
      stories = data || []
    }

    const storyMap = new Map(stories.map((story) => [String(story.id), story]))
    const episodes = selected.flatMap((episode) => {
      const story = storyMap.get(String(episode.story_id))
      if (!story) return []

      const deletedAtMs = Date.parse(episode.deleted_at)
      const expiresAtMs = Date.parse(episode.delete_expires_at)
      if (!Number.isFinite(deletedAtMs) || !Number.isFinite(expiresAtMs)) return []

      const restoreUntil = Math.min(expiresAtMs, deletedAtMs + 30 * dayMs)
      if (restoreUntil <= nowMs) return []

      const storyDeleted = Boolean(story.deleted_at)
      if (storyDeleted) {
        const storyDeletedAtMs = Date.parse(story.deleted_at)
        const storyExpiresAtMs = Date.parse(story.delete_expires_at)
        if (!Number.isFinite(storyDeletedAtMs) || !Number.isFinite(storyExpiresAtMs)) return []
        if (Math.min(storyExpiresAtMs, storyDeletedAtMs + 30 * dayMs) <= nowMs) return []
      }

      return [{
        id: episode.id,
        story_id: episode.story_id,
        title: episode.title || '',
        episode_number: episode.episode_number,
        deleted_at: episode.deleted_at,
        delete_expires_at: new Date(restoreUntil).toISOString(),
        days_left: Math.ceil((restoreUntil - nowMs) / dayMs),
        story_title: story.title || '',
        story_cover_url: story.cover_url || '',
        story_deleted: storyDeleted,
        story_delete_expires_at: story.delete_expires_at || null,
        can_restore: !storyDeleted,
      }]
    })

    return res.status(200).json({
      ok: true,
      episodes,
      page,
      limit,
      has_more: hasMore,
      next_page: hasMore ? page + 1 : null,
    })
  } catch (error) {
    console.error('GET AUTHOR DELETED EPISODES ERROR:', error)
    return res.status(500).json({
      ok: false,
      code: 'EPISODE_TRASH_LIST_ERROR',
      message: 'Failed to load deleted episodes',
    })
  }
}
