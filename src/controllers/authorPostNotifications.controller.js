import { supabase } from '../config/supabase.js'

async function getActiveAuthorPost(postId) {
  const { data, error } = await supabase
    .from('author_page_posts')
    .select('id')
    .eq('id', postId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error

  return data || null
}

export async function getMyAuthorPostNotificationPreference(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id
    const postId = String(req.params.postId || '').trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    const post = await getActiveAuthorPost(postId)

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    const { data, error } = await supabase
      .from('author_post_notification_preferences')
      .select('notifications_enabled, created_at, updated_at')
      .eq('user_id', userId)
      .eq('post_id', postId)
      .maybeSingle()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      post_id: postId,
      notifications_enabled: data
        ? Boolean(data.notifications_enabled)
        : true,
      preference: data || null,
    })
  } catch (error) {
    console.error(
      'GET AUTHOR POST NOTIFICATION PREFERENCE ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to load notification preference',
      error: error.message,
    })
  }
}

export async function updateMyAuthorPostNotificationPreference(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id
    const postId = String(req.params.postId || '').trim()
    const enabled =
      req.body?.notifications_enabled ??
      req.body?.enabled

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        ok: false,
        message: 'notifications_enabled must be true or false',
      })
    }

    const post = await getActiveAuthorPost(postId)

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    const { data, error } = await supabase
      .from('author_post_notification_preferences')
      .upsert(
        {
          user_id: userId,
          post_id: postId,
          notifications_enabled: enabled,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: 'user_id,post_id',
        }
      )
      .select(
        'user_id, post_id, notifications_enabled, created_at, updated_at'
      )
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: enabled
        ? 'Post notifications turned on'
        : 'Post notifications turned off',
      preference: data,
    })
  } catch (error) {
    console.error(
      'UPDATE AUTHOR POST NOTIFICATION PREFERENCE ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to update notification preference',
      error: error.message,
    })
  }
}
