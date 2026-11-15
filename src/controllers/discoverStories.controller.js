import { supabase } from '../config/supabase.js'
import {
  getDiscoverStorySharedCatalog,
} from '../services/discoverStorySharedCache.service.js'
import {
  getDiscoverStoryInteractionHistory,
} from '../services/discoverStoryPersonalizationCache.service.js'

function asTime(value) {
  return new Date(value || 0).getTime()
}

function getLimit(value) {
  const parsed = Number.parseInt(value, 10)

  if (!Number.isFinite(parsed)) {
    return 20
  }

  return Math.min(30, Math.max(1, parsed))
}

function getExcludedCreators(value) {
  if (typeof value !== 'string' || value.length > 7000) return new Set()

  const validKey = /^(?:author|reader):[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
  return new Set(
    value.split(',')
      .slice(0, 100)
      .filter((key) => validKey.test(key))
      .map((key) => key.toLowerCase())
  )
}

function makeAuthorStory(story, hasViewed) {
  return {
    id: story.id,
    source_type: 'author',
    creator_id: story.author_page_id,
    media_type: story.media_type,
    media_url: story.media_url,
    mime_type: story.mime_type,
    caption: story.caption || '',
    alt_text: story.alt_text || '',
    text_overlay: story.text_overlay || '',
    text_overlay_style: story.text_overlay_style || null,
    mention_username:
    story.mention_username || '',
    mention_target_type: story.mention_target_type || null,
    mention_target_id: story.mention_target_id || null,
    link_url: story.link_url || '',
    allow_messages: Boolean(
      story.allow_messages
    ),
    view_count: Number(
      story.view_count || 0
    ),
    has_viewed: Boolean(hasViewed),
    created_at: story.created_at,
    expires_at: story.expires_at,
  }
}

function makeReaderStory(story, hasViewed) {
  return {
    id: story.id,
    source_type: 'reader',
    creator_id: story.user_id,
    media_type: story.media_type,
    media_url: story.media_url,
    mime_type: story.mime_type,
    caption: story.caption || '',
    alt_text: story.alt_text || '',
    text_overlay: story.text_overlay || '',
    text_overlay_style: story.text_overlay_style || null,
    mention_username:
    story.mention_username || '',
    mention_target_type: story.mention_target_type || null,
    mention_target_id: story.mention_target_id || null,
    link_url: story.link_url || '',
    allow_messages: Boolean(
      story.allow_messages
    ),
    view_count: Number(
      story.view_count || 0
    ),
    has_viewed: Boolean(hasViewed),
    created_at: story.created_at,
    expires_at: story.expires_at,
  }
}

function sortStories(stories) {
  return [...stories].sort(
    (left, right) => {
      if (
        left.has_viewed !==
        right.has_viewed
      ) {
        return left.has_viewed ? 1 : -1
      }

      return (
        asTime(left.created_at) -
        asTime(right.created_at)
      )
    }
  )
}

function calculateScore(group) {
  if (group.is_owner) {
    return 10000
  }

  const newestAgeHours = Math.max(
    0,
    (
      Date.now() -
      asTime(group.latest_created_at)
    ) / 3600000
  )

  const recencyScore = Math.max(
    0,
    15 - newestAgeHours * 0.625
  )

  const creatorBonus =
    group.creator.type === 'author'
      ? 35
      : 0

  const unseenScore =
    group.has_unseen ? 25 : -30

  const followScore =
    group.is_following ? 10 : 0

  const mutualScore =
    group.is_mutual ? 10 : 0

  const interactionScore = Math.min(
    60,
    Number(
      group.recent_view_count || 0
    ) * 8
  )

  return (
    creatorBonus +
    unseenScore +
    followScore +
    mutualScore +
    interactionScore +
    recencyScore
  )
}

function emptyResult() {
  return Promise.resolve({
    data: [],
    error: null,
  })
}


export async function getDiscoverStoriesFeed(req, res) {
  try {
    const userId = String(req.user?.user_id || '').trim()
    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const groupLimit = getLimit(req.query.limit)
    const excludedCreators = getExcludedCreators(req.query.exclude_creators)
    const now = new Date().toISOString()
    const { authorStories, readerStories, authorPages, readers } =
      await getDiscoverStorySharedCatalog(now)

    const authorPageIds = [...new Set(authorPages.map((page) => page.id).filter(Boolean))]
    const readerIds = [...new Set(readers.map((reader) => reader.id).filter(Boolean))]
    const authorStoryIds = [...new Set(authorStories.map((story) => story.id).filter(Boolean))]
    const readerStoryIds = [...new Set(readerStories.map((story) => story.id).filter(Boolean))]
    const creatorUserIds = [
      ...new Set([
        ...authorPages.map((page) => page.user_id),
        ...readerIds,
      ].filter((id) => Boolean(id) && String(id) !== userId)),
    ]

    const [
      authorFollowsResult,
      readerFollowsResult,
      reverseReaderFollowsResult,
      activeAuthorViewsResult,
      activeReaderViewsResult,
      privateReadersResult,
      blockedPagesResult,
      blockedByViewerResult,
      blockedViewerResult,
      blockedByAuthorResult,
      interactionHistory,
    ] = await Promise.all([
      authorPageIds.length
        ? supabase.from('author_page_follows').select('author_page_id')
            .eq('follower_user_id', userId).in('author_page_id', authorPageIds)
        : emptyResult(),
      readerIds.length
        ? supabase.from('user_follows').select('following_user_id')
            .eq('follower_user_id', userId).in('following_user_id', readerIds)
        : emptyResult(),
      readerIds.length
        ? supabase.from('user_follows').select('follower_user_id')
            .eq('following_user_id', userId).in('follower_user_id', readerIds)
        : emptyResult(),
      authorStoryIds.length
        ? supabase.from('author_page_story_views').select('story_id')
            .eq('viewer_user_id', userId).in('story_id', authorStoryIds)
        : emptyResult(),
      readerStoryIds.length
        ? supabase.from('reader_story_views').select('story_id')
            .eq('viewer_user_id', userId).in('story_id', readerStoryIds)
        : emptyResult(),
      readerIds.length
        ? supabase.from('users').select('id')
            .in('id', readerIds).eq('reader_posts_private', true)
        : emptyResult(),
      authorPageIds.length
        ? supabase.from('reader_blocked_author_pages').select('author_page_id')
            .eq('reader_user_id', userId).in('author_page_id', authorPageIds)
        : emptyResult(),
      creatorUserIds.length
        ? supabase.from('chat_blocks').select('blocked_user_id')
            .eq('blocker_user_id', userId).in('blocked_user_id', creatorUserIds)
        : emptyResult(),
      creatorUserIds.length
        ? supabase.from('chat_blocks').select('blocker_user_id')
            .eq('blocked_user_id', userId).in('blocker_user_id', creatorUserIds)
        : emptyResult(),
      authorPageIds.length
        ? supabase.from('author_blocked_readers').select('author_page_id')
            .eq('reader_user_id', userId).eq('scope_type', 'all_author')
            .eq('is_active', true).gt('expires_at', now)
            .in('author_page_id', authorPageIds)
        : emptyResult(),
      getDiscoverStoryInteractionHistory(userId),
    ])

    for (const result of [
      authorFollowsResult,
      readerFollowsResult,
      reverseReaderFollowsResult,
      activeAuthorViewsResult,
      activeReaderViewsResult,
      privateReadersResult,
      blockedPagesResult,
      blockedByViewerResult,
      blockedViewerResult,
      blockedByAuthorResult,
    ]) {
      if (result.error) throw result.error
    }

    const toSet = (result, field) =>
      new Set((result.data || []).map((row) => String(row[field])).filter(Boolean))
    const followedAuthorIds = toSet(authorFollowsResult, 'author_page_id')
    const followedReaderIds = toSet(readerFollowsResult, 'following_user_id')
    const readersFollowingViewer = toSet(reverseReaderFollowsResult, 'follower_user_id')
    const viewedAuthorStoryIds = toSet(activeAuthorViewsResult, 'story_id')
    const viewedReaderStoryIds = toSet(activeReaderViewsResult, 'story_id')
    const privateReaderIds = toSet(privateReadersResult, 'id')
    const blockedPageIds = new Set([
      ...toSet(blockedPagesResult, 'author_page_id'),
      ...toSet(blockedByAuthorResult, 'author_page_id'),
    ])
    const blockedAccountIds = new Set([
      ...toSet(blockedByViewerResult, 'blocked_user_id'),
      ...toSet(blockedViewerResult, 'blocker_user_id'),
    ])

    const authorViewCounts = interactionHistory.authorViewCounts || new Map()
    const readerViewCounts = interactionHistory.readerViewCounts || new Map()
    const authorById = new Map(authorPages.map((page) => [String(page.id), page]))
    const readerById = new Map(readers.map((reader) => [String(reader.id), reader]))
    const groups = new Map()

    for (const story of authorStories) {
      const page = authorById.get(String(story.author_page_id))
      if (!page) continue
      const isOwner = String(page.user_id) === userId
      if (!isOwner && excludedCreators.has(`author:${page.id}`)) continue
      if (!isOwner && (
        blockedPageIds.has(String(page.id)) ||
        blockedAccountIds.has(String(page.user_id))
      )) continue
      const isFollowing = followedAuthorIds.has(String(page.id))
      const key = `author:${page.id}`
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          creator: {
            type: 'author',
            id: page.id,
            user_id: page.user_id,
            name: page.page_name || 'Author',
            username: page.page_username || '',
            avatar_url: page.avatar_url || '',
          },
          is_owner: isOwner,
          is_following: isFollowing,
          is_mutual: false,
          recent_view_count: authorViewCounts.get(page.id) || 0,
          latest_created_at: story.created_at,
          stories: [],
        })
      }
      const group = groups.get(key)
      if (asTime(story.created_at) > asTime(group.latest_created_at)) {
        group.latest_created_at = story.created_at
      }
      group.stories.push(makeAuthorStory(story, isOwner || viewedAuthorStoryIds.has(String(story.id))))
    }

    for (const story of readerStories) {
      const reader = readerById.get(String(story.user_id))
      if (!reader) continue
      const isOwner = String(reader.id) === userId
      if (!isOwner && excludedCreators.has(`reader:${reader.id}`)) continue
      const isFollowing = followedReaderIds.has(String(reader.id))
      if (!isOwner && (
        blockedAccountIds.has(String(reader.id)) ||
        (privateReaderIds.has(String(reader.id)) && !isFollowing)
      )) continue
      const key = `reader:${reader.id}`
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          creator: {
            type: 'reader',
            id: reader.id,
            user_id: reader.id,
            name: reader.name || 'Reader',
            username: reader.username || '',
            avatar_url: reader.avatar_url || '',
          },
          is_owner: isOwner,
          is_following: isFollowing,
          is_mutual: isFollowing && readersFollowingViewer.has(String(reader.id)),
          recent_view_count: readerViewCounts.get(reader.id) || 0,
          latest_created_at: story.created_at,
          stories: [],
        })
      }
      const group = groups.get(key)
      if (asTime(story.created_at) > asTime(group.latest_created_at)) {
        group.latest_created_at = story.created_at
      }
      group.stories.push(makeReaderStory(story, isOwner || viewedReaderStoryIds.has(String(story.id))))
    }

    const ranked = [...groups.values()].map((group) => {
      const stories = sortStories(group.stories)
      const hasUnseen = stories.some((story) => !story.has_viewed)
      const normalized = { ...group, stories, has_unseen: hasUnseen }
      const recentViews = Number(group.recent_view_count || 0)
      const discoveryPenalty = !group.is_following && !group.is_owner
        ? Math.min(20, recentViews * 5)
        : 0
      return {
        ...normalized,
        ranking_score: calculateScore(normalized) -
          (group.creator.type === 'author' ? 35 : 0) - discoveryPenalty,
      }
    }).sort((left, right) => {
      if (left.ranking_score !== right.ranking_score) {
        return right.ranking_score - left.ranking_score
      }
      if (left.has_unseen !== right.has_unseen) return left.has_unseen ? -1 : 1
      return asTime(right.latest_created_at) - asTime(left.latest_created_at)
    })

    let selected = ranked
    if (ranked.length > groupLimit) {
      const owners = ranked.filter((group) => group.is_owner)
      const following = ranked.filter((group) => !group.is_owner && group.is_following)
      const related = ranked.filter((group) => !group.is_owner && !group.is_following && (
        group.is_mutual || Number(group.recent_view_count || 0) > 0
      ))
      const discovery = ranked.filter((group) => !group.is_owner && !group.is_following &&
        !group.is_mutual && !Number(group.recent_view_count || 0))
      const relatedTarget = Math.max(0, Math.round(groupLimit * 0.6) - owners.length)
      selected = [...owners, ...following.slice(0, relatedTarget)]
      selected.push(...related.slice(0, Math.max(0, relatedTarget - following.length)))
      selected.push(...discovery.slice(0, Math.max(0, groupLimit - selected.length)))
      const selectedKeys = new Set(selected.map((group) => group.key))
      const remaining = ranked.filter((group) => !selectedKeys.has(group.key))
      selected.push(...remaining.slice(0, Math.max(0, groupLimit - selected.length)))
      selected = selected.slice(0, groupLimit).sort((left, right) => {
        if (left.ranking_score !== right.ranking_score) {
          return right.ranking_score - left.ranking_score
        }
        return asTime(right.latest_created_at) - asTime(left.latest_created_at)
      })
    }

    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({
      ok: true,
      groups: selected,
      ranking_version: 'hybrid-v2',
    })
  } catch (error) {
    console.error('GET DISCOVER STORIES FEED ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load Discover stories',
      error: error.message,
    })
  }
}
