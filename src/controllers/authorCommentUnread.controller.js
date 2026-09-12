import { supabase } from '../config/supabase.js'

export async function getMyAuthorUnreadCommentCount(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Authentication required',
      })
    }

    const { data: stories, error: storyError } = await supabase
      .from('stories')
      .select('id')
      .eq('user_id', userId)

    if (storyError) throw storyError

    const storyIds = (stories || [])
      .map((story) => story.id)
      .filter(Boolean)

    if (!storyIds.length) {
      return res.status(200).json({
        ok: true,
        unread_count: 0,
      })
    }

    const { count, error } = await supabase
      .from('comments')
      .select('id', {
        count: 'exact',
        head: true,
      })
      .in('story_id', storyIds)
      .neq('user_id', userId)
      .is('author_read_at', null)
      .eq('is_hidden', false)
      .is('deleted_at', null)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      unread_count: Number(count || 0),
    })
  } catch (error) {
    console.error(
      'GET AUTHOR UNREAD COMMENT COUNT ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to load unread comment count',
      error: error.message,
    })
  }
}
