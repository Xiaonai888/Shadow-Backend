import { supabase } from '../config/supabase.js'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20
const PAGE_SCAN_LIMIT = 120

function getLimit(value) {
  const parsed = Number.parseInt(
    value,
    10
  )

  if (!Number.isFinite(parsed)) {
    return DEFAULT_LIMIT
  }

  return Math.min(
    MAX_LIMIT,
    Math.max(1, parsed)
  )
}

function normalizeTerm(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
}

function normalizeTags(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map(normalizeTerm)
    .filter(Boolean)
}

function daysSince(value) {
  const time = new Date(
    value || 0
  ).getTime()

  if (!time) {
    return 3650
  }

  return Math.max(
    0,
    (Date.now() - time) /
      86400000
  )
}

function formatReason({
  preferredGenre,
  recentFollowers,
  createdAt,
  totalFollowers,
  totalStories,
}) {
  if (preferredGenre) {
    return `Popular in ${preferredGenre}`
  }

  if (recentFollowers >= 3) {
    return 'Rising author'
  }

  if (
    daysSince(createdAt) <= 90 &&
    totalStories > 0
  ) {
    return 'New voice on Shadow'
  }

  if (totalFollowers > 0) {
    return `${totalFollowers.toLocaleString()} followers`
  }

  return `${totalStories.toLocaleString()} ${
    totalStories === 1
      ? 'story'
      : 'stories'
  }`
}

export async function getDiscoverAuthorSuggestions(
  req,
  res
) {
  try {
    const userId = req.user?.user_id
    const limit = getLimit(
      req.query.limit
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const {
      data: followRows,
      error: followError,
    } = await supabase
      .from('author_page_follows')
      .select('author_page_id')
      .eq(
        'follower_user_id',
        userId
      )

    if (followError) {
      throw followError
    }

    const followedIds = new Set(
      (followRows || [])
        .map(
          (row) =>
            row.author_page_id
        )
        .filter(Boolean)
    )

    const {
      data: pages,
      error: pagesError,
    } = await supabase
      .from('author_pages')
      .select(
        'id, user_id, page_name, page_username, bio, avatar_url, cover_url, total_stories, total_followers, created_at, updated_at'
      )
      .eq('status', 'active')
      .order('updated_at', {
        ascending: false,
      })
      .limit(PAGE_SCAN_LIMIT)

    if (pagesError) {
      throw pagesError
    }

    const candidates = (
      pages || []
    ).filter(
      (page) =>
        page?.id &&
        page?.page_username &&
        String(page.user_id) !==
          String(userId) &&
        !followedIds.has(page.id)
    )

    if (!candidates.length) {
      return res.status(200).json({
        ok: true,
        author_pages: [],
        ranking_version:
          'discover-authors-v1',
      })
    }

    const candidateIds =
      candidates.map(
        (page) => page.id
      )
    const followedIdList = [
      ...followedIds,
    ]
    const recentStart = new Date(
      Date.now() -
        30 * 86400000
    ).toISOString()

    const [
      candidateStoriesResult,
      followedStoriesResult,
      recentFollowsResult,
    ] = await Promise.all([
      supabase
        .from('stories')
        .select(
          'author_id, main_genre, tags, total_views, total_likes, total_comments, updated_at'
        )
        .in(
          'author_id',
          candidateIds
        )
        .eq('status', 'published')
        .is('deleted_at', null),
      followedIdList.length
        ? supabase
            .from('stories')
            .select(
              'author_id, main_genre, tags'
            )
            .in(
              'author_id',
              followedIdList
            )
            .eq(
              'status',
              'published'
            )
            .is(
              'deleted_at',
              null
            )
        : Promise.resolve({
            data: [],
            error: null,
          }),
      supabase
        .from(
          'author_page_follows'
        )
        .select(
          'author_page_id, created_at'
        )
        .in(
          'author_page_id',
          candidateIds
        )
        .gte(
          'created_at',
          recentStart
        ),
    ])

    for (const result of [
      candidateStoriesResult,
      followedStoriesResult,
      recentFollowsResult,
    ]) {
      if (result.error) {
        throw result.error
      }
    }

    const genrePreference =
      new Map()
    const tagPreference = new Map()

    for (
      const story of
      followedStoriesResult.data || []
    ) {
      const genre = normalizeTerm(
        story.main_genre
      )

      if (genre) {
        genrePreference.set(
          genre,
          (
            genrePreference.get(
              genre
            ) || 0
          ) + 3
        )
      }

      for (
        const tag of normalizeTags(
          story.tags
        )
      ) {
        tagPreference.set(
          tag,
          (
            tagPreference.get(
              tag
            ) || 0
          ) + 1
        )
      }
    }

    const storyStats = new Map()

    for (
      const story of
      candidateStoriesResult.data || []
    ) {
      const authorId =
        story.author_id

      if (!authorId) {
        continue
      }

      if (
        !storyStats.has(authorId)
      ) {
        storyStats.set(authorId, {
          totalStories: 0,
          totalViews: 0,
          totalLikes: 0,
          totalComments: 0,
          latestUpdate: null,
          genres: new Map(),
          tags: new Map(),
        })
      }

      const stats =
        storyStats.get(authorId)

      stats.totalStories += 1
      stats.totalViews += Number(
        story.total_views || 0
      )
      stats.totalLikes += Number(
        story.total_likes || 0
      )
      stats.totalComments += Number(
        story.total_comments || 0
      )

      if (
        !stats.latestUpdate ||
        new Date(
          story.updated_at || 0
        ).getTime() >
          new Date(
            stats.latestUpdate || 0
          ).getTime()
      ) {
        stats.latestUpdate =
          story.updated_at
      }

      const genre = normalizeTerm(
        story.main_genre
      )

      if (genre) {
        stats.genres.set(
          genre,
          (
            stats.genres.get(
              genre
            ) || 0
          ) + 1
        )
      }

      for (
        const tag of normalizeTags(
          story.tags
        )
      ) {
        stats.tags.set(
          tag,
          (
            stats.tags.get(
              tag
            ) || 0
          ) + 1
        )
      }
    }

    const recentFollowers =
      new Map()

    for (
      const row of
      recentFollowsResult.data || []
    ) {
      recentFollowers.set(
        row.author_page_id,
        (
          recentFollowers.get(
            row.author_page_id
          ) || 0
        ) + 1
      )
    }

    const ranked = candidates
      .map((page) => {
        const stats =
          storyStats.get(page.id) || {
            totalStories: 0,
            totalViews: 0,
            totalLikes: 0,
            totalComments: 0,
            latestUpdate: null,
            genres: new Map(),
            tags: new Map(),
          }

        const genreEntries = [
          ...stats.genres.entries(),
        ].sort(
          (left, right) =>
            right[1] - left[1]
        )
        const primaryGenres =
          genreEntries
            .slice(0, 2)
            .map(
              ([genre]) => genre
            )

        let genreMatch = 0
        let preferredGenre = ''

        for (
          const [
            genre,
            count,
          ] of genreEntries
        ) {
          const preference =
            genrePreference.get(
              genre
            ) || 0
          const value =
            preference *
            Math.min(3, count)

          genreMatch += value

          if (
            !preferredGenre &&
            preference > 0
          ) {
            preferredGenre =
              genre
          }
        }

        let tagMatch = 0

        for (
          const [
            tag,
            count,
          ] of stats.tags
        ) {
          tagMatch +=
            (
              tagPreference.get(
                tag
              ) || 0
            ) *
            Math.min(2, count)
        }

        const totalFollowers =
          Number(
            page.total_followers || 0
          )
        const totalStories =
          Math.max(
            Number(
              page.total_stories || 0
            ),
            stats.totalStories
          )
        const recentFollowerCount =
          recentFollowers.get(
            page.id
          ) || 0
        const engagement =
          stats.totalViews +
          stats.totalLikes * 3 +
          stats.totalComments * 5
        const latestActivity =
          stats.latestUpdate ||
          page.updated_at ||
          page.created_at

        const score =
          Math.min(
            40,
            genreMatch * 4
          ) +
          Math.min(
            20,
            tagMatch * 2
          ) +
          Math.min(
            12,
            Math.log10(
              totalFollowers + 1
            ) * 4
          ) +
          Math.min(
            15,
            Math.log10(
              engagement + 1
            ) * 3
          ) +
          Math.min(
            10,
            recentFollowerCount * 2
          ) +
          Math.max(
            0,
            8 -
              daysSince(
                latestActivity
              ) /
                7
          ) +
          Math.min(
            8,
            totalStories * 2
          ) +
          (
            daysSince(
              page.created_at
            ) <= 90 &&
            totalStories > 0
              ? 6
              : 0
          )

        return {
          id: page.id,
          user_id: page.user_id,
          page_name:
            page.page_name ||
            'Author',
          page_username:
            page.page_username,
          bio: page.bio || '',
          avatar_url:
            page.avatar_url || '',
          cover_url:
            page.cover_url || '',
          total_followers:
            totalFollowers,
          total_stories:
            totalStories,
          primary_genres:
            primaryGenres,
          recent_followers:
            recentFollowerCount,
          reason: formatReason({
            preferredGenre,
            recentFollowers:
              recentFollowerCount,
            createdAt:
              page.created_at,
            totalFollowers,
            totalStories,
          }),
          is_following: false,
          is_owner: false,
          ranking_score:
            Number(
              score.toFixed(2)
            ),
        }
      })
      .filter(
        (page) =>
          page.total_stories > 0
      )
      .sort((left, right) => {
        if (
          right.ranking_score !==
          left.ranking_score
        ) {
          return (
            right.ranking_score -
            left.ranking_score
          )
        }

        if (
          right.total_followers !==
          left.total_followers
        ) {
          return (
            right.total_followers -
            left.total_followers
          )
        }

        return left.page_name.localeCompare(
          right.page_name
        )
      })
      .slice(0, limit)

    return res.status(200).json({
      ok: true,
      author_pages: ranked,
      ranking_version:
        'discover-authors-v1',
    })
  } catch (error) {
    console.error(
      'GET DISCOVER AUTHOR SUGGESTIONS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load Discover Authors',
      error: error.message,
    })
  }
}
