import { supabase } from '../config/supabase.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 30
const CANDIDATE_LIMIT = 300
const POST_WINDOW_DAYS = 30
const USER_INTEREST_LIMIT = 100
const INTEREST_HALF_LIFE_DAYS = 30
const MAX_MATCHED_INTERESTS = 3
const MAX_PERSONALIZATION_BOOST = 12

function clampLimit(value) {
  const number = Number(value || DEFAULT_LIMIT)

  if (!Number.isFinite(number)) {
    return DEFAULT_LIMIT
  }

  return Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(number))
  )
}

function normalizeImages(value) {
  if (!Array.isArray(value)) return []

  return value
    .map((item) =>
      String(item || '').trim()
    )
    .filter(Boolean)
    .slice(0, 5)
}

function encodeCursor(value) {
  return Buffer.from(
    JSON.stringify(value),
    'utf8'
  ).toString('base64url')
}

function decodeCursor(value) {
  if (!value) return null

  try {
    const decoded = JSON.parse(
      Buffer.from(
        String(value),
        'base64url'
      ).toString('utf8')
    )
    const snapshotAt =
      new Date(decoded.snapshot_at)
    const offset =
      Number(decoded.offset || 0)

    if (
      Number.isNaN(
        snapshotAt.getTime()
      ) ||
      !Number.isInteger(offset) ||
      offset < 0
    ) {
      return null
    }

    return {
      snapshot_at:
        snapshotAt.toISOString(),
      offset,
    }
  } catch {
    return null
  }
}

function compareNewest(first, second) {
  const timeDifference =
    new Date(
      second.created_at
    ).getTime() -
    new Date(
      first.created_at
    ).getTime()

  if (timeDifference !== 0) {
    return timeDifference
  }

  return String(second.id)
    .localeCompare(
      String(first.id)
    )
}

function getDecayedInterestScore(
  interest,
  snapshotAt
) {
  const score = Math.max(
    0,
    Number(
      interest?.interest_score || 0
    )
  )

  if (!score) {
    return 0
  }

  const snapshotTime =
    new Date(snapshotAt).getTime()
  const signalTime =
    new Date(
      interest?.last_signal_at || 0
    ).getTime()

  if (
    !Number.isFinite(snapshotTime) ||
    !Number.isFinite(signalTime)
  ) {
    return score
  }

  const ageDays =
    Math.max(
      0,
      snapshotTime - signalTime
    ) /
    (24 * 60 * 60 * 1000)

  return (
    score *
    Math.pow(
      0.5,
      ageDays /
        INTEREST_HALF_LIFE_DAYS
    )
  )
}

function buildPersonalizationByPost(
  userInterests,
  postHashtags,
  snapshotAt
) {
  const interestByHashtag =
    new Map()

  for (const item of userInterests || []) {
    const hashtagId =
      String(
        item?.hashtag_id || ''
      )

    if (!hashtagId) {
      continue
    }

    const score =
      getDecayedInterestScore(
        item,
        snapshotAt
      )

    if (score <= 0.01) {
      continue
    }

    interestByHashtag.set(
      hashtagId,
      score
    )
  }

  if (!interestByHashtag.size) {
    return new Map()
  }

  const matchedScoresByPost =
    new Map()

  for (const row of postHashtags || []) {
    const postId =
      String(row?.post_id || '')
    const hashtagId =
      String(
        row?.hashtag_id || ''
      )

    if (!postId || !hashtagId) {
      continue
    }

    const score =
      interestByHashtag.get(
        hashtagId
      )

    if (!score) {
      continue
    }

    if (
      !matchedScoresByPost.has(
        postId
      )
    ) {
      matchedScoresByPost.set(
        postId,
        []
      )
    }

    matchedScoresByPost
      .get(postId)
      .push(score)
  }

  const personalizationByPost =
    new Map()

  for (
    const [postId, scores] of
    matchedScoresByPost.entries()
  ) {
    const strongestMatches =
      [...scores]
        .sort(
          (first, second) =>
            second - first
        )
        .slice(
          0,
          MAX_MATCHED_INTERESTS
        )

    const matchedInterest =
      Math.min(
        100,
        strongestMatches.reduce(
          (sum, score) =>
            sum + score,
          0
        )
      )

    const boost =
      matchedInterest > 0
        ? (
            Math.log1p(
              matchedInterest
            ) /
            Math.log1p(100)
          ) *
          MAX_PERSONALIZATION_BOOST
        : 0

    if (boost > 0) {
      personalizationByPost.set(
        postId,
        boost
      )
    }
  }

  return personalizationByPost
}

function getRecommendationScore(
  post,
  authorPage,
  snapshotAt,
  personalizationBoost = 0
) {
  const snapshotTime =
    new Date(snapshotAt).getTime()

  const createdTime =
    new Date(
      post?.created_at || 0
    ).getTime()

  const ageMs =
    Number.isFinite(snapshotTime) &&
    Number.isFinite(createdTime)
      ? Math.max(
          0,
          snapshotTime - createdTime
        )
      : 0

  const ageDays =
    ageMs /
    (24 * 60 * 60 * 1000)

  const likes = Math.max(
    0,
    Number(post?.like_count || 0)
  )

  const comments = Math.max(
    0,
    Number(
      post?.comment_count || 0
    )
  )

  const echoes = Math.max(
    0,
    Number(post?.echo_count || 0)
  )

  const engagement =
    likes +
    comments * 2 +
    echoes * 3

  const engagementScore =
    Math.log1p(engagement) * 12

  const recencyScore =
    Math.max(
      0,
      18 - ageDays * 0.6
    )

  const discoveryBoost =
    authorPage?.is_following
      ? 0
      : 2

  const ownerBoost =
    authorPage?.is_owner
      ? 1
      : 0

  const personalizationScore =
    authorPage?.is_owner
      ? 0
      : Math.min(
          MAX_PERSONALIZATION_BOOST,
          Math.max(
            0,
            Number(
              personalizationBoost || 0
            )
          )
        )

  return (
    engagementScore +
    recencyScore +
    discoveryBoost +
    ownerBoost +
    personalizationScore
  )
}

function compareRecommended(
  first,
  second,
  authorById,
  snapshotAt,
  personalizationByPost
) {
  const firstAuthor =
    authorById.get(
      String(
        first.author_page_id
      )
    )

  const secondAuthor =
    authorById.get(
      String(
        second.author_page_id
      )
    )

  const firstScore =
    getRecommendationScore(
      first,
      firstAuthor,
      snapshotAt,
      personalizationByPost.get(
        String(first.id)
      ) || 0
    )

  const secondScore =
    getRecommendationScore(
      second,
      secondAuthor,
      snapshotAt,
      personalizationByPost.get(
        String(second.id)
      ) || 0
    )

  const scoreDifference =
    secondScore - firstScore

  if (
    Math.abs(scoreDifference) >
    0.000001
  ) {
    return scoreDifference
  }

  return compareNewest(
    first,
    second
  )
}

function buildReactionData(
  rows,
  userId
) {
  const summaryByPost = new Map()
  const myReactionByPost = new Map()

  for (const row of rows || []) {
    const postId = row.post_id
    const reactionType = String(
      row.reaction_type || ''
    )
      .trim()
      .toLowerCase()

    if (!postId || !reactionType) {
      continue
    }

    if (!summaryByPost.has(postId)) {
      summaryByPost.set(
        postId,
        new Map()
      )
    }

    const counts =
      summaryByPost.get(postId)

    counts.set(
      reactionType,
      Number(
        counts.get(reactionType) || 0
      ) + 1
    )

    if (
      String(row.user_id) ===
      String(userId)
    ) {
      myReactionByPost.set(
        postId,
        reactionType
      )
    }
  }

  const normalizedSummary =
    new Map()

  for (
    const [postId, counts] of
    summaryByPost.entries()
  ) {
    normalizedSummary.set(
      postId,
      [...counts.entries()]
        .map(
          ([type, count]) => ({
            type,
            count,
          })
        )
        .sort(
          (first, second) => {
            if (
              second.count !==
              first.count
            ) {
              return (
                second.count -
                first.count
              )
            }

            return first.type
              .localeCompare(
                second.type
              )
          }
        )
        .slice(0, 3)
    )
  }

  return {
    summaryByPost:
      normalizedSummary,
    myReactionByPost,
  }
}

export async function getDiscoverAuthorPostsFeed(
  req,
  res
) {
  try {
    const userId =
      req.user?.user_id
    const limit =
      clampLimit(req.query.limit)
    const cursor =
      decodeCursor(
        req.query.cursor
      )
    const snapshotAt =
      cursor?.snapshot_at ||
      new Date().toISOString()
    const offset =
      cursor?.offset || 0
    const cutoffAt =
      new Date(
        new Date(
          snapshotAt
        ).getTime() -
          POST_WINDOW_DAYS *
            24 *
            60 *
            60 *
            1000
      ).toISOString()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const {
      data: candidatePosts,
      error: postsError,
    } = await supabase
      .from('author_page_posts')
      .select(
        'id, author_page_id, user_id, post_type, content, image_urls, status, like_count, comment_count, echo_count, created_at, updated_at'
      )
      .eq('status', 'active')
      .lte(
        'created_at',
        snapshotAt
      )
      .gte(
        'created_at',
        cutoffAt
      )
      .order('created_at', {
        ascending: false,
      })
      .order('id', {
        ascending: false,
      })
      .limit(CANDIDATE_LIMIT)

    if (postsError) {
      throw postsError
    }

    const candidatePostIds = [
      ...new Set(
        (candidatePosts || [])
          .map(
            (post) =>
              post.id
          )
          .filter(Boolean)
      ),
    ]

    const authorPageIds = [
      ...new Set(
        (candidatePosts || [])
          .map(
            (post) =>
              post.author_page_id
          )
          .filter(Boolean)
      ),
    ]

    if (!authorPageIds.length) {
      return res.status(200).json({
        ok: true,
        posts: [],
        limit,
        has_more: false,
        next_cursor: null,
        snapshot_at:
          snapshotAt,
      })
    }

    const [
      pagesResult,
      followsResult,
      pageBlocksResult,
      interestsResult,
      postHashtagsResult,
    ] = await Promise.all([
      supabase
        .from('author_pages')
        .select(
          'id, user_id, page_name, page_username, avatar_url, status, total_followers'
        )
        .in(
          'id',
          authorPageIds
        )
        .eq(
          'status',
          'active'
        ),
      supabase
        .from(
          'author_page_follows'
        )
        .select(
          'author_page_id'
        )
        .eq(
          'follower_user_id',
          userId
        )
        .in(
          'author_page_id',
          authorPageIds
        ),
      supabase
        .from(
          'reader_blocked_author_pages'
        )
        .select(
          'author_page_id'
        )
        .eq(
          'reader_user_id',
          userId
        )
        .in(
          'author_page_id',
          authorPageIds
        ),
      supabase
        .from(
          'user_hashtag_interests'
        )
        .select(
          'hashtag_id, interest_score, last_signal_at'
        )
        .eq(
          'user_id',
          userId
        )
        .gt(
          'interest_score',
          0
        )
        .order(
          'interest_score',
          {
            ascending: false,
          }
        )
        .limit(
          USER_INTEREST_LIMIT
        ),
      supabase
        .from(
          'author_post_hashtags'
        )
        .select(
          'post_id, hashtag_id'
        )
        .in(
          'post_id',
          candidatePostIds
        ),
    ])

    if (pagesResult.error) {
      throw pagesResult.error
    }

    if (followsResult.error) {
      throw followsResult.error
    }

    if (pageBlocksResult.error) {
      throw pageBlocksResult.error
    }

    if (interestsResult.error) {
      throw interestsResult.error
    }

    if (postHashtagsResult.error) {
      throw postHashtagsResult.error
    }

    const personalizationByPost =
      buildPersonalizationByPost(
        interestsResult.data || [],
        postHashtagsResult.data || [],
        snapshotAt
      )

    const pages =
      pagesResult.data || []
    const pageUserIds = [
      ...new Set(
        pages
          .map(
            (page) =>
              page.user_id
          )
          .filter(Boolean)
      ),
    ]

    let accountBlocks = []

    if (pageUserIds.length) {
      const {
        data,
        error,
      } = await supabase
        .from('chat_blocks')
        .select(
          'blocked_user_id'
        )
        .eq(
          'blocker_user_id',
          userId
        )
        .in(
          'blocked_user_id',
          pageUserIds
        )

      if (error) throw error

      accountBlocks =
        data || []
    }

    const followedPageIds =
      new Set(
        (
          followsResult.data ||
          []
        ).map(
          (item) =>
            String(
              item.author_page_id
            )
        )
      )
    const blockedPageIds =
      new Set(
        (
          pageBlocksResult.data ||
          []
        ).map(
          (item) =>
            String(
              item.author_page_id
            )
        )
      )
    const blockedUserIds =
      new Set(
        accountBlocks.map(
          (item) =>
            String(
              item.blocked_user_id
            )
        )
      )
    const authorById =
      new Map(
        pages
          .filter(
            (page) =>
              !blockedPageIds.has(
                String(page.id)
              ) &&
              !blockedUserIds.has(
                String(
                  page.user_id
                )
              )
          )
          .map((page) => [
            String(page.id),
            {
              id: page.id,
              user_id:
                page.user_id,
              page_name:
                page.page_name,
              page_username:
                page.page_username,
              avatar_url:
                page.avatar_url,
              total_followers:
                Number(
                  page.total_followers ||
                    0
                ),
              is_following:
                followedPageIds.has(
                  String(page.id)
                ),
              is_owner:
                String(
                  page.user_id
                ) ===
                String(userId),
            },
          ])
      )

    const newestVisiblePostId =
      (candidatePosts || []).find(
        (post) =>
          authorById.has(
            String(
              post.author_page_id
            )
          )
      )?.id

    const visiblePosts =
      (candidatePosts || [])
        .filter((post) =>
          authorById.has(
            String(
              post.author_page_id
            )
          )
        )
        .sort((first, second) => {
          if (
            first.id === newestVisiblePostId
          ) {
            return -1
          }

          if (
            second.id === newestVisiblePostId
          ) {
            return 1
          }

          return compareRecommended(
            first,
            second,
            authorById,
            snapshotAt,
            personalizationByPost
          )
        })

    const selectedPosts =
      visiblePosts.slice(
        offset,
        offset + limit
      )
    const selectedPostIds =
      selectedPosts.map(
        (post) => post.id
      )

    let reactionRows = []
    const echoCountByPost =
      new Map()

    if (selectedPostIds.length) {
      const [
        reactionResult,
        echoResult,
      ] = await Promise.all([
        supabase
          .from(
            'author_page_post_reactions'
          )
          .select(
            'post_id, user_id, reaction_type'
          )
          .in(
            'post_id',
            selectedPostIds
          ),
        supabase
          .from('social_echoes_v2')
          .select(
            'source_id, share_count'
          )
          .eq(
            'source_type',
            'author_post'
          )
          .in(
            'source_id',
            selectedPostIds
          ),
      ])

      if (reactionResult.error) {
        throw reactionResult.error
      }

      if (echoResult.error) {
        throw echoResult.error
      }

      reactionRows =
        reactionResult.data || []

      for (
        const row of
        echoResult.data || []
      ) {
        const postId =
          String(
            row.source_id || ''
          )

        echoCountByPost.set(
          postId,
          Number(
            echoCountByPost.get(
              postId
            ) || 0
          ) +
            Math.max(
              1,
              Number(
                row.share_count || 1
              )
            )
        )
      }
    }

    const {
      summaryByPost,
      myReactionByPost,
    } = buildReactionData(
      reactionRows,
      userId
    )

    const posts =
      selectedPosts.map(
        (post) => {
          const authorPage =
            authorById.get(
              String(
                post.author_page_id
              )
            ) || null

          return {
            id: post.id,
            author_page_id:
              post.author_page_id,
            user_id:
              post.user_id,
            post_type:
              post.post_type ||
              'article',
            content:
              post.content || '',
            image_urls:
              normalizeImages(
                post.image_urls
              ),
            like_count:
              Number(
                post.like_count ||
                  0
              ),
            comment_count:
              Number(
                post.comment_count ||
                  0
              ),
            echo_count:
              Number(
                echoCountByPost.get(
                  String(post.id)
                ) || 0
              ),
            echo_state_loaded: true,
            reaction_summary:
              summaryByPost.get(
                post.id
              ) || [],
            my_reaction:
              myReactionByPost.get(
                post.id
              ) || null,
            created_at:
              post.created_at,
            updated_at:
              post.updated_at,
            is_following:
              Boolean(
                authorPage
                  ?.is_following
              ),
            is_owner:
              Boolean(
                authorPage
                  ?.is_owner
              ),
            author_page:
              authorPage,
          }
        }
      )

    const nextOffset =
      offset + posts.length
    const hasMore =
      nextOffset <
      visiblePosts.length

    return res.status(200).json({
      ok: true,
      posts,
      limit,
      has_more: hasMore,
      next_cursor: hasMore
        ? encodeCursor({
            snapshot_at:
              snapshotAt,
            offset:
              nextOffset,
          })
        : null,
      snapshot_at:
        snapshotAt,
    })
  } catch (error) {
    console.error(
      'GET DISCOVER AUTHOR POSTS FEED ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load discover author posts',
      error:
        error.message,
    })
  }
}
