import { supabase } from '../config/supabase.js'
import { getStoryDetailReaderStatus } from './library.controller.js'

let missingRpcWarned = false

export async function getStoryDetailReaderStatusOptimized(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id || null
    const storyId = String(req.params.storyId || '').trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!storyId) {
      return res.status(400).json({
        ok: false,
        message: 'Story id is required',
      })
    }

    const { data, error } = await supabase.rpc(
      'get_reader_story_detail_status',
      {
        p_story_id: storyId,
        p_user_id: userId,
      }
    )

    if (error && (error.code === 'PGRST202' || error.code === '42883')) {
      if (!missingRpcWarned) {
        missingRpcWarned = true
        console.warn('STORY DETAIL STATUS RPC NOT INSTALLED; USING LEGACY HANDLER')
      }
      return getStoryDetailReaderStatus(req, res)
    }

    if (error) throw error

    if (!data || data.story_found !== true) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    res.setHeader('Cache-Control', 'private, no-store')

    return res.status(200).json({
      ok: true,
      bookmarked: data.bookmarked === true,
      subscribed: data.subscribed === true,
      author_state_loaded: data.author_state_loaded === true,
      author_following: data.author_following === true,
      author_follower_count: Math.max(0, Number(data.author_follower_count || 0)),
      author_is_owner: data.author_is_owner === true,
    })
  } catch (error) {
    console.error('GET STORY DETAIL READER STATUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load story detail status',
      error: error.message,
    })
  }
}
