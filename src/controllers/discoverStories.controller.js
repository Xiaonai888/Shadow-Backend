import { supabase } from '../config/supabase.js'
import {
  cleanupExpiredAuthorStories,
} from './authorStories.controller.js'
import {
  cleanupExpiredReaderStories,
} from './readerStories.controller.js'

const HISTORY_DAYS = 30
const MAX_HISTORY_ROWS = 1000

function asTime(value) {
  return new Date(value || 0).getTime()
}

function getLimit(value) {
  const parsed = Number.parseInt(
    value,
    10
  )

  if (!Number.isFinite(parsed)) {
    return 20
  }

  return Math.min(
    30,
    Math.max(1, parsed)
  )
}

function countByCreator(
  rows,
  storyToCreator
) {
  const counts = new Map()

  for (const row of rows || []) {
    const creatorId =
      storyToCreator.get(row.story_id)

    if (!creatorId) continue

    counts.set(
      creatorId,
      (counts.get(creatorId) || 0) +
        1
    )
  }

  return counts
}

function makeAuthorStory(
  story,
  hasViewed
) {
  return {
    id: story.id,
    source_type: 'author',
    creator_id:
      story.author_page_id,
    media_type: story.media_type,
    media_url: story.media_url,
    mime_type: story.mime_type,
    caption: story.caption || '',
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

function makeReaderStory(
  story,
  hasViewed
) {
  return {
    id: story.id,
    source_type: 'reader',
    creator_id: story.user_id,
    media_type: story.media_type,
    media_url: story.media_url,
    mime_type: story.mime_type,
    caption: story.caption || '',
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
        return left.has_viewed
          ? 1
          : -1
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
      asTime(
        group.latest_created_at
      )
    ) /
      3600000
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

async function readStoryCreatorMaps(
  authorStoryIds,
  readerStoryIds
) {
  const [
    authorResult,
    readerResult,
  ] = await Promise.all([
    authorStoryIds.length
      ? supabase
          .from(
            'author_page_stories'
          )
          .select(
            'id, author_page_id'
          )
          .in('id', authorStoryIds)
      : Promise.resolve({
          data: [],
          error: null,
        }),
    readerStoryIds.length
      ? supabase
          .from('reader_stories')
          .select('id, user_id')
          .in('id', readerStoryIds)
      : Promise.resolve({
          data: [],
          error: null,
        }),
  ])

  if (authorResult.error) {
    throw authorResult.error
  }

  if (readerResult.error) {
    throw readerResult.error
  }

  return {
    authorStoryToCreator: new Map(
      (authorResult.data || []).map(
        (story) => [
          story.id,
          story.author_page_id,
        ]
      )
    ),
    readerStoryToCreator: new Map(
      (readerResult.data || []).map(
        (story) => [
          story.id,
          story.user_id,
        ]
      )
    ),
  }
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

    await Promise.all([
      cleanupExpiredAuthorStories()
        .catch((error) => {
          console.error(
            'DISCOVER AUTHOR STORY CLEANUP ERROR:',
            error.message
          )
        }),
      cleanupExpiredReaderStories()
        .catch((error) => {
          console.error(
            'DISCOVER READER STORY CLEANUP ERROR:',
            error.message
          )
        }),
    ])

    const groupLimit = getLimit(
      req.query.limit
    )
    const now =
      new Date().toISOString()
    const historyStart = new Date(
      Date.now() -
        HISTORY_DAYS *
          24 *
          60 *
          60 *
          1000
    ).toISOString()

    const [
      authorStoriesResult,
      readerStoriesResult,
    ] = await Promise.all([
      supabase
        .from('author_page_stories')
        .select(
          'id, author_page_id, media_type, media_url, mime_type, caption, allow_messages, view_count, created_at, expires_at'
        )
        .eq('status', 'active')
        .gt('expires_at', now)
        .order('created_at', {
          ascending: false,
        })
        .limit(300),
      supabase
        .from('reader_stories')
        .select(
          'id, user_id, media_type, media_url, mime_type, caption, allow_messages, view_count, created_at, expires_at'
        )
        .eq('status', 'active')
        .gt('expires_at', now)
        .order('created_at', {
          ascending: false,
        })
        .limit(300),
    ])

    if (authorStoriesResult.error) {
      throw authorStoriesResult.error
    }

    if (readerStoriesResult.error) {
      throw readerStoriesResult.error
    }

    const authorStories =
      authorStoriesResult.data || []
    const readerStories =
      readerStoriesResult.data || []

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

    const authorStoryIds =
      authorStories.map(
        (story) => story.id
      )
    const readerStoryIds =
      readerStories.map(
        (story) => story.id
      )

    const [
      authorPagesResult,
      readersResult,
      authorFollowsResult,
      readerFollowsResult,
      reverseReaderFollowsResult,
      authorViewsResult,
      readerViewsResult,
    ] = await Promise.all([
      authorPageIds.length
        ? supabase
            .from('author_pages')
            .select(
              'id, user_id, page_name, page_username, avatar_url, status'
            )
            .in('id', authorPageIds)
            .eq('status', 'active')
        : Promise.resolve({
            data: [],
            error: null,
          }),
      readerIds.length
        ? supabase
            .from('users')
            .select(
              'id, name, username, avatar_url, is_active'
            )
            .in('id', readerIds)
            .eq('is_active', true)
        : Promise.resolve({
            data: [],
            error: null,
          }),
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
        : Promise.resolve({
            data: [],
            error: null,
          }),
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
        : Promise.resolve({
            data: [],
            error: null,
          }),
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
        : Promise.resolve({
            data: [],
            error: null,
          }),
      supabase
        .from(
          'author_page_story_views'
        )
        .select(
          'story_id, viewed_at'
        )
        .eq(
          'viewer_user_id',
          userId
        )
        .gte(
          'viewed_at',
          historyStart
        )
        .order('viewed_at', {
          ascending: false,
        })
        .limit(MAX_HISTORY_ROWS),
      supabase
        .from('reader_story_views')
        .select(
          'story_id, viewed_at'
        )
        .eq(
          'viewer_user_id',
          userId
        )
        .gte(
          'viewed_at',
          historyStart
        )
        .order('viewed_at', {
          ascending: false,
        })
        .limit(MAX_HISTORY_ROWS),
    ])

    for (const result of [
      authorPagesResult,
      readersResult,
      authorFollowsResult,
      readerFollowsResult,
      reverseReaderFollowsResult,
      authorViewsResult,
      readerViewsResult,
    ]) {
      if (result.error) {
        throw result.error
      }
    }

    const authorHistoryStoryIds = [
      ...new Set(
        (authorViewsResult.data || [])
          .map(
            (row) => row.story_id
          )
          .filter(Boolean)
      ),
    ]

    const readerHistoryStoryIds = [
      ...new Set(
        (readerViewsResult.data || [])
          .map(
            (row) => row.story_id
          )
          .filter(Boolean)
      ),
    ]

    const {
      authorStoryToCreator,
      readerStoryToCreator,
    } = await readStoryCreatorMaps(
      authorHistoryStoryIds,
      readerHistoryStoryIds
    )

    const authorViewCounts =
      countByCreator(
        authorViewsResult.data,
        authorStoryToCreator
      )

    const readerViewCounts =
      countByCreator(
        readerViewsResult.data,
        readerStoryToCreator
      )

    const viewedAuthorStoryIds =
      new Set(
        authorViewsResult.data
          .map((row) => row.story_id)
      )

    const viewedReaderStoryIds =
      new Set(
        readerViewsResult.data
          .map((row) => row.story_id)
      )

    const followedAuthorIds =
      new Set(
        (
          authorFollowsResult.data ||
          []
        ).map(
          (row) =>
            row.author_page_id
        )
      )

    const followedReaderIds =
      new Set(
        (
          readerFollowsResult.data ||
          []
        ).map(
          (row) =>
            row.following_user_id
        )
      )

    const readersFollowingViewer =
      new Set(
        (
          reverseReaderFollowsResult.data ||
          []
        ).map(
          (row) =>
            row.follower_user_id
        )
      )

    const authorById = new Map(
      (
        authorPagesResult.data || []
      ).map((page) => [
        page.id,
        page,
      ])
    )

    const readerById = new Map(
      (
        readersResult.data || []
      ).map((reader) => [
        reader.id,
        reader,
      ])
    )

    const groups = new Map()

    for (
      const story of authorStories
    ) {
      const page = authorById.get(
        story.author_page_id
      )

      if (
        !page ||
        !followedAuthorIds.has(
          page.id
        )
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
              page.page_name ||
              'Author',
            username:
              page.page_username ||
              '',
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

    for (
      const story of readerStories
    ) {
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
              reader.name ||
              'Reader',
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
