import { supabase } from '../config/supabase.js'
import { cleanupExpiredAuthorStories } from './authorStories.controller.js'

function publicStory(story, hasViewed) {
  const expiresAt = story?.expires_at ? new Date(story.expires_at).getTime() : 0

  return {
    id: story.id,
    author_page_id: story.author_page_id,
    media_type: story.media_type,
    media_url: story.media_url,
    mime_type: story.mime_type,
    caption: story.caption || '',
    allow_messages: Boolean(story.allow_messages),
    view_count: Number(story.view_count || 0),
    has_viewed: Boolean(hasViewed),
    created_at: story.created_at,
    expires_at: story.expires_at,
    remaining_seconds: expiresAt
      ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      : 0,
  }
}

function latestTimestamp(group) {
  return new Date(group.latest_created_at || 0).getTime()
}

export async function getAuthorStoriesFeed(req, res) {
  try {
    await cleanupExpiredAuthorStories().catch((error) => {
      console.error('AUTHOR STORY FEED CLEANUP ERROR:', error.message)
    })

    const userId = req.user?.user_id || null
    const groupLimit = Math.min(30, Math.max(1, Number(req.query.limit || 20)))
    const storyLimit = Math.min(300, Math.max(groupLimit, Number(req.query.story_limit || 150)))
    const now = new Date().toISOString()

    const { data: stories, error: storiesError } = await supabase
      .from('author_page_stories')
      .select('id, author_page_id, media_type, media_url, mime_type, caption, allow_messages, view_count, created_at, expires_at')
      .eq('status', 'active')
      .gt('expires_at', now)
      .order('created_at', { ascending: false })
      .limit(storyLimit)

    if (storiesError) throw storiesError

    const storyIds = (stories || []).map((story) => story.id).filter(Boolean)
    const authorPageIds = [...new Set((stories || []).map((story) => story.author_page_id).filter(Boolean))]

    if (!authorPageIds.length) {
      return res.status(200).json({
        ok: true,
        groups: [],
      })
    }

    const { data: authorPages, error: pagesError } = await supabase
      .from('author_pages')
      .select('id, user_id, page_name, page_username, avatar_url, status')
      .in('id', authorPageIds)
      .eq('status', 'active')

    if (pagesError) throw pagesError

    let followedPageIds = new Set()
    let viewedStoryIds = new Set()

    if (userId) {
      const [{ data: followRows, error: followError }, { data: viewRows, error: viewError }] =
        await Promise.all([
          supabase
            .from('author_page_follows')
            .select('author_page_id')
            .eq('follower_user_id', userId)
            .in('author_page_id', authorPageIds),
          storyIds.length
            ? supabase
                .from('author_page_story_views')
                .select('story_id')
                .eq('viewer_user_id', userId)
                .in('story_id', storyIds)
            : Promise.resolve({ data: [], error: null }),
        ])

      if (followError) throw followError
      if (viewError) throw viewError

      followedPageIds = new Set((followRows || []).map((item) => item.author_page_id))
      viewedStoryIds = new Set((viewRows || []).map((item) => item.story_id))
    }

    const pageById = new Map((authorPages || []).map((page) => [page.id, page]))
    const groupByPageId = new Map()

    for (const story of stories || []) {
      const authorPage = pageById.get(story.author_page_id)

      if (!authorPage) continue

      const isOwner = Boolean(userId && String(authorPage.user_id) === String(userId))
      const hasViewed = isOwner || viewedStoryIds.has(story.id)

      if (!groupByPageId.has(authorPage.id)) {
        groupByPageId.set(authorPage.id, {
          author_page: {
            id: authorPage.id,
            page_name: authorPage.page_name,
            page_username: authorPage.page_username,
            avatar_url: authorPage.avatar_url || '',
          },
          is_owner: isOwner,
          is_following: followedPageIds.has(authorPage.id),
          latest_created_at: story.created_at,
          stories: [],
        })
      }

      groupByPageId.get(authorPage.id).stories.push(publicStory(story, hasViewed))
    }

    const groups = [...groupByPageId.values()]
      .map((group) => {
        const sortedStories = [...group.stories].sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        )

        return {
          ...group,
          stories: sortedStories,
          has_unseen: sortedStories.some((story) => !story.has_viewed),
        }
      })
      .sort((a, b) => {
        if (a.is_owner !== b.is_owner) return a.is_owner ? -1 : 1
        if (a.has_unseen !== b.has_unseen) return a.has_unseen ? -1 : 1
        if (a.is_following !== b.is_following) return a.is_following ? -1 : 1
        return latestTimestamp(b) - latestTimestamp(a)
      })
      .slice(0, groupLimit)

    return res.status(200).json({
      ok: true,
      groups,
    })
  } catch (error) {
    console.error('GET AUTHOR STORIES FEED ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load author stories',
      error: error.message,
    })
  }
}
