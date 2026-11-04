import { supabase } from '../config/supabase.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Route must use requireAdminPermission('stories.manage') before this handler.
// The database function performs the actual atomic restore as DRAFT.
export async function restoreDeletedEpisodeByAdmin(req, res) {
  try {
    if (!req.admin?.admin_id) {
      return res.status(403).json({ ok: false, code: 'ADMIN_ACCESS_REQUIRED', message: 'Admin access required' })
    }

    const storyId = String(req.params.storyId || '').trim()
    const episodeId = String(req.params.episodeId || '').trim()

    if (!UUID_RE.test(storyId) || !UUID_RE.test(episodeId)) {
      return res.status(400).json({ ok: false, code: 'INVALID_ID', message: 'Invalid story or episode ID' })
    }

    // Never accept the author's user ID from the request body.
    const { data: story, error: storyError } = await supabase
      .from('stories')
      .select('id, user_id, author_id, title, deleted_at')
      .eq('id', storyId)
      .maybeSingle()

    if (storyError) throw storyError
    if (!story) {
      return res.status(404).json({ ok: false, code: 'STORY_NOT_FOUND', message: 'Story not found' })
    }
    if (story.deleted_at) {
      return res.status(409).json({
        ok: false,
        code: 'RESTORE_STORY_FIRST',
        message: 'Restore the parent story before restoring an episode',
      })
    }

    const userId = String(story.user_id || '').trim()
    if (!userId) {
      return res.status(409).json({ ok: false, code: 'STORY_OWNER_MISSING', message: 'Story owner is missing' })
    }

    const { data: episode, error: episodeError } = await supabase
      .from('episodes')
      .select('id, story_id, title, episode_number, deleted_at, delete_expires_at')
      .eq('id', episodeId)
      .eq('story_id', storyId)
      .maybeSingle()

    if (episodeError) throw episodeError
    if (!episode) {
      return res.status(404).json({ ok: false, code: 'EPISODE_NOT_FOUND', message: 'Episode not found' })
    }
    if (!episode.deleted_at) {
      return res.status(409).json({ ok: false, code: 'EPISODE_NOT_DELETED', message: 'Episode is not deleted' })
    }

    const deletionMs = Date.parse(episode.deleted_at)
    const expiryMs = Date.parse(episode.delete_expires_at || '')
    if (!Number.isFinite(deletionMs) || !Number.isFinite(expiryMs) ||
      Math.min(expiryMs, deletionMs + 30 * 24 * 60 * 60 * 1000) <= Date.now()) {
      return res.status(410).json({ ok: false, code: 'RESTORE_EXPIRED', message: 'Episode restore period has expired' })
    }

    const { data, error } = await supabase.rpc('restore_author_episode_v1', {
      p_story_id: storyId,
      p_episode_id: episodeId,
      p_user_id: userId,
    })

    if (error) {
      console.error('ADMIN EPISODE RESTORE RPC ERROR:', { storyId, episodeId, code: error.code, message: error.message })
      if (error.code === '23505') {
        return res.status(409).json({ ok: false, code: 'EPISODE_NUMBER_CONFLICT', message: 'An active episode already uses this episode number' })
      }
      return res.status(500).json({ ok: false, code: 'RESTORE_DATABASE_ERROR', message: 'Failed to restore episode' })
    }

    const result = Array.isArray(data) ? data[0] : data
    if (!result || result.ok !== true) {
      const code = result?.code || 'RESTORE_FAILED'
      const status = {
        STORY_NOT_AVAILABLE: 409,
        EPISODE_NOT_FOUND: 404,
        RESTORE_EXPIRED: 410,
        EPISODE_NUMBER_CONFLICT: 409,
      }[code] || 400
      return res.status(status).json({ ok: false, code, message: result?.message || 'Failed to restore episode' })
    }

    if (result.already_restored) {
      return res.status(409).json({ ok: false, code: 'EPISODE_ALREADY_RESTORED', message: 'Episode is already restored' })
    }

    // Audit is best effort: failure must not roll back an already successful restore.
    const actor = String(req.admin.actor || req.admin.email || req.admin.admin_id).slice(0, 200)
    const audit = await supabase.from('story_moderation_logs').insert({
      story_id: storyId,
      author_id: story.author_id,
      action: 'admin_episode_restored',
      reason: `Restored episode #${episode.episode_number} (${episodeId}) to Draft`,
      admin_actor: actor,
    })
    if (audit.error) {
      console.error('ADMIN EPISODE RESTORE AUDIT ERROR:', { storyId, episodeId, code: audit.error.code, message: audit.error.message })
    }

    return res.status(200).json({
      ok: true,
      episode_id: episodeId,
      story_id: storyId,
      status: 'draft',
      message: 'Episode restored to Draft',
      total_episodes: result.total_episodes,
    })
  } catch (error) {
    console.error('ADMIN EPISODE RESTORE ERROR:', error)
    return res.status(500).json({ ok: false, code: 'ADMIN_EPISODE_RESTORE_ERROR', message: 'Failed to restore episode' })
  }
}
