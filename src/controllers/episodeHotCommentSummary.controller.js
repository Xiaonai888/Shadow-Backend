import { supabase } from '../config/supabase.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getEpisodeHotCommentSummary(req, res) {
  const episodeId = String(req.params.episodeId || '').trim()

  if (!UUID_PATTERN.test(episodeId)) {
    return res.status(400).json({
      ok: false,
      message: 'Valid episode ID is required',
    })
  }

  try {
    const { data, error } = await supabase.rpc(
      'get_episode_hot_comment_summary',
      { p_episode_id: episodeId }
    )

    if (error) throw error

    if (!data?.episode_found) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    res.setHeader('Cache-Control', 'private, no-store')

    return res.status(200).json({
      ok: true,
      episode_id: episodeId,
      total: Math.max(0, Number(data.total || 0)),
      hot_comment: data.hot_comment || null,
    })
  } catch (error) {
    console.error('GET EPISODE HOT COMMENT SUMMARY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load hot comment summary',
    })
  }
}
