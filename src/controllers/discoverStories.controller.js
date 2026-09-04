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
    mention_username:
      story.mention_username || '',
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
    mention_username:
      story.mention_username || '',
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

export async function getDiscoverStoriesFeed(
  req,
  res
) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const groupLimit = getLimit(
      req.query.limit
    )
    const now =
      new Date().toISOString()

    const {
      authorStories,
      readerStories,
      authorPages,
      readers,
    } =
      await getDiscoverStorySharedCatalog(
        now
      )

    const authorPageIds = [
      ...new Set(
        authorStories
          .map(
            (story) =>
              story.author_page_id
          )
          .filter(Boolean)
      ),
    ]

    const readerIds = [
      ...new Set(
        readerStories
          .map(
            (story) => story.user_id
          )
          .filter(Boolean)
      ),
    ]

    const authorStoryIds = [
      ...new Set(
        authorStories
          .map((story) => story.id)
          .filter(Boolean)
      ),
    ]

    const readerStoryIds = [
      ...new Set(
        readerStories
          .map((story) => story.id)
          .filter(Boolean)
      ),
    ]

    const [
      authorFollowsResult,
      readerFollowsResult,
      reverseReaderFollowsResult,
      activeAuthorViewsResult,
      activeReaderViewsResult,
      interactionHistory,
    ] = await Promise.all([
      authorPageIds.length
        ? supabase
            .from(
              'author_page_follows'
            )
            .select('author_page_id')
            .eq(
              'follower_user_id',
              userId
            )
            .in(
              'author_page_id',
              authorPageIds
            )
        : emptyResult(),
      readerIds.length
        ? supabase
            .from('user_follows')
            .select(
              'following_user_id'
            )
            .eq(
              'follower_user_id',
              userId
            )
            .in(
              'following_user_id',
              readerIds
            )
        : emptyResult(),
      readerIds.length
        ? supabase
            .from('user_follows')
            .select(
              'follower_user_id'
            )
            .eq(
              'following_user_id',
              userId
            )
            .in(
              'follower_user_id',
              readerIds
            )
        : emptyResult(),
      authorStoryIds.length
        ? supabase
            .from(
              'author_page_story_views'
            )
            .select('story_id')
            .eq(
              'viewer_user_id',
              userId
            )
            .in(
              'story_id',
              authorStoryIds
            )
        : emptyResult(),
      readerStoryIds.length
        ? supabase
            .from(
              'reader_story_views'
            )
            .select('story_id')
            .eq(
              'viewer_user_id',
              userId
            )
            .in(
              'story_id',
              readerStoryIds
            )
        : emptyResult(),
      getDiscoverStoryInteractionHistory(
        userId
      ),
    ])

    for (const result of [
      authorFollowsResult,
      readerFollowsResult,
      reverseReaderFollowsResult,
      activeAuthorViewsResult,
      activeReaderViewsResult,
    ]) {
      if (result.error) {
        throw result.error
      }
    }

    const authorViewCounts =
      interactionHistory
        .authorViewCounts || new Map()

    const readerViewCounts =
      interactionHistory
        .readerViewCounts || new Map()

    const viewedAuthorStoryIds =
      new Set(
        (
          activeAuthorViewsResult.data ||
          []
        )
          .map((row) => row.story_id)
          .filter(Boolean)
      )

    const viewedReaderStoryIds =
      new Set(
        (
          activeReaderViewsResult.data ||
          []
        )
          .map((row) => row.story_id)
          .filter(Boolean)
      )

    const followedAuthorIds =
      new Set(
        (
          authorFollowsResult.data ||
          []
        )
          .map(
            (row) =>
              row.author_page_id
          )
          .filter(Boolean)
      )

    const followedReaderIds =
      new Set(
        (
          readerFollowsResult.data ||
          []
        )
          .map(
            (row) =>
              row.following_user_id
          )
          .filter(Boolean)
      )

    const readersFollowingViewer =
      new Set(
        (
          reverseReaderFollowsResult.data ||
          []
        )
          .map(
            (row) =>
              row.follower_user_id
          )
          .filter(Boolean)
      )

    const authorById = new Map(
      authorPages.map((page) => [
        page.id,
        page,
      ])
    )

    const readerById = new Map(
      readers.map((reader) => [
        reader.id,
        reader,
      ])
    )

    const groups = new Map()

    for (const story of authorStories) {
      const page = authorById.get(
        story.author_page_id
      )

      if (
        !page ||
        !followedAuthorIds.has(page.id)
      ) {
        continue
      }

      const key = `author:${page.id}`

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          creator: {
            type: 'author',
            id: page.id,
            user_id: page.user_id,
            name:
              page.page_name || 'Author',
            username:
              page.page_username || '',
            avatar_url:
              page.avatar_url || '',
          },
          is_owner: false,
          is_following: true,
          is_mutual: false,
          recent_view_count:
            authorViewCounts.get(
              page.id
            ) || 0,
          latest_created_at:
            story.created_at,
          stories: [],
        })
      }

      const group = groups.get(key)

      if (
        asTime(story.created_at) >
        asTime(
          group.latest_created_at
        )
      ) {
        group.latest_created_at =
          story.created_at
      }

      group.stories.push(
        makeAuthorStory(
          story,
          viewedAuthorStoryIds.has(
            story.id
          )
        )
      )
    }

    for (const story of readerStories) {
      const reader = readerById.get(
        story.user_id
      )
      const isOwner =
        String(story.user_id) ===
        String(userId)
      const isFollowing =
        followedReaderIds.has(
          story.user_id
        )

      if (
        !reader ||
        (!isOwner && !isFollowing)
      ) {
        continue
      }

      const key =
        `reader:${reader.id}`

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          creator: {
            type: 'reader',
            id: reader.id,
            user_id: reader.id,
            name:
              reader.name || 'Reader',
            username:
              reader.username || '',
            avatar_url:
              reader.avatar_url || '',
          },
          is_owner: isOwner,
          is_following:
            isFollowing,
          is_mutual:
            isFollowing &&
            readersFollowingViewer.has(
              reader.id
            ),
          recent_view_count:
            readerViewCounts.get(
              reader.id
            ) || 0,
          latest_created_at:
            story.created_at,
          stories: [],
        })
      }

      const group = groups.get(key)

      if (
        asTime(story.created_at) >
        asTime(
          group.latest_created_at
        )
      ) {
        group.latest_created_at =
          story.created_at
      }

      group.stories.push(
        makeReaderStory(
          story,
          isOwner ||
            viewedReaderStoryIds.has(
              story.id
            )
        )
      )
    }

    const rankedGroups = [
      ...groups.values(),
    ]
      .map((group) => {
        const stories = sortStories(
          group.stories
        )
        const hasUnseen =
          stories.some(
            (story) =>
              !story.has_viewed
          )

        const normalized = {
          ...group,
          stories,
          has_unseen: hasUnseen,
        }

        return {
          ...normalized,
          ranking_score:
            calculateScore(
              normalized
            ),
        }
      })
      .sort((left, right) => {
        if (
          left.ranking_score !==
          right.ranking_score
        ) {
          return (
            right.ranking_score -
            left.ranking_score
          )
        }

        if (
          left.has_unseen !==
          right.has_unseen
        ) {
          return left.has_unseen
            ? -1
            : 1
        }

        if (
          left.creator.type !==
          right.creator.type
        ) {
          return left.creator.type ===
            'author'
            ? -1
            : 1
        }

        return (
          asTime(
            right.latest_created_at
          ) -
          asTime(
            left.latest_created_at
          )
        )
      })
      .slice(0, groupLimit)

    res.set(
      'Cache-Control',
      'private, no-store'
    )

    return res.status(200).json({
      ok: true,
      groups: rankedGroups,
      ranking_version:
        'followed-v1',
    })
  } catch (error) {
    console.error(
      'GET DISCOVER STORIES FEED ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load Discover stories',
      error: error.message,
    })
  }
}
