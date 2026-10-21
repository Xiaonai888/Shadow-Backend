import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function send(res, status, payload) {
  res.set('Cache-Control', 'private, no-store')
  return res.status(status).json(payload)
}

export async function getMyReaderPostTags(req, res) {
  const userId = String(req.user?.user_id || req.user?.id || '').trim()
  const postId = String(req.params?.postId || '').trim()

  if (!UUID.test(userId)) {
    return send(res, 401, { ok: false, message: 'Please sign in again.' })
  }
  if (!UUID.test(postId)) {
    return send(res, 400, { ok: false, message: 'Invalid post ID.' })
  }

  try {
    const { data: post, error: postError } = await supabase
      .from('reader_posts')
      .select('id')
      .eq('id', postId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle()

    if (postError) throw postError
    if (!post) {
      return send(res, 404, { ok: false, message: 'Post not found.' })
    }

    const { data: links, error: linksError } = await supabase
      .from('reader_tag_mention_links')
      .select('target_user_id')
      .eq('post_id', postId)
      .eq('actor_user_id', userId)
      .eq('kind', 'tag')
      .in('status', ['approved', 'pending'])
      .limit(20)

    if (linksError) throw linksError

    const ids = [...new Set((links || []).map((row) => String(row.target_user_id || '')).filter(Boolean))]
    if (!ids.length) {
      return send(res, 200, { ok: true, tagged_users: [] })
    }

    const { data: readers, error: readersError } = await supabase
      .from('users')
      .select('id,name,username,avatar_url')
      .eq('is_active', true)
      .in('id', ids)

    if (readersError) throw readersError

    const readersById = new Map((readers || []).map((reader) => [String(reader.id), reader]))
    const taggedUsers = ids.map((id) => readersById.get(id)).filter(Boolean)

    return send(res, 200, { ok: true, tagged_users: taggedUsers })
  } catch (error) {
    console.error('GET MY READER POST TAGS ERROR:', error)
    return send(res, 500, { ok: false, message: 'Unable to load post tags.' })
  }
}
