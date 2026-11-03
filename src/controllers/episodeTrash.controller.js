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
