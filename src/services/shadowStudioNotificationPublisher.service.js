import { supabase } from '../config/supabase.js'
import { createAuthorPageNotification } from '../controllers/authorPageNotifications.controller.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function publishStudioReelCommentNotification({ videoId, ownerId, actorId, commentId, videoTitle = '' }) {
  if (![videoId, ownerId, actorId, commentId].every(value => UUID.test(String(value || '')))) return null
  if (ownerId === actorId) return null

  const [pageResult, actorResult] = await Promise.all([
    supabase.from('author_pages')
      .select('id').eq('user_id', ownerId).eq('status', 'active').maybeSingle(),
    supabase.from('users')
      .select('name,username,avatar_url').eq('id', actorId).maybeSingle(),
  ])
  if (pageResult.error) throw pageResult.error
  if (actorResult.error) throw actorResult.error
  if (!pageResult.data) return null

  const actor = actorResult.data || {}
  const name = String(actor.name || actor.username || 'Reader').slice(0, 80)
  const title = String(videoTitle || 'your Reel').slice(0, 120)

  return createAuthorPageNotification({
    authorPageId: pageResult.data.id,
    userId: ownerId,
    type: 'comment',
    title: `${name} commented on your Reel`,
    message: title,
    targetUrl: `/author/reel/studio/videos/${encodeURIComponent(videoId)}/analytics?section=engagement`,
    metadata: {
      source: 'fast_reel',
      notification_type: 'comment',
      video_id: videoId,
      comment_id: commentId,
      actor_id: actorId,
      actor_name: name,
      actor_username: String(actor.username || ''),
      actor_avatar_url: String(actor.avatar_url || ''),
    },
  })
}
