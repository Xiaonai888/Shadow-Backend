import { supabase } from '../config/supabase.js'
import {
  deleteStoryCommentToTrash,
  getCommentTrashMessage,
  getCommentTrashStatus,
} from '../services/commentTrash.service.js'
import {
  saveAuthorCommentActivityLogSafely,
} from '../services/authorCommentActivity.service.js'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 30
const MAX_REVIEWS = 1000
const VALID_STATUSES = new Set([
  'hidden',
  'kept_hidden',
  'restored',
  'deleted',
])

function cleanText(value) {
  return String(value || '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizePage(value) {
  const number = Number(value)

  if (!Number.isFinite(number) || number < 1) {
    return 1
  }

  return Math.floor(number)
}

function normalizeLimit(value) {
  const number = Number(value)

  if (!Number.isFinite(number) || number < 1) {
    return DEFAULT_LIMIT
  }

  return Math.min(
    MAX_LIMIT,
    Math.floor(number)
  )
}

function normalizeStatus(value) {
  const status = cleanText(value).toLowerCase()

  return VALID_STATUSES.has(status)
    ? status
    : 'hidden'
}

function normalizeSort(value) {
  return cleanText(value).toLowerCase() === 'oldest'
    ? 'oldest'
    : 'newest'
}

function normalizeRpcResult(data) {
  if (Array.isArray(data)) {
    return data[0] || {}
  }

  return data && typeof data === 'object'
    ? data
    : {}
}

function publicUser(user, fallbackId = '') {
  return {
    id: user?.id || fallbackId || null,
    name:
      user?.name ||
      user?.username ||
      'Reader',
    username:
      user?.username || '',
    avatar_url:
      user?.avatar_url || '',
  }
}

function publicStory(story, fallbackId = '') {
  return {
    id: story?.id || fallbackId || null,
    title:
      story?.title ||
      'Unknown story',
    cover_url:
      story?.cover_url || '',
  }
}

function publicEpisode(episode, fallbackId = '') {
  if (!episode && !fallbackId) {
    return null
  }

  return {
    id: episode?.id || fallbackId || null,
    title:
      episode?.title || '',
    episode_number:
      Number(
        episode?.episode_number || 0
      ),
  }
}

function publicMatchedWords(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => {
      if (typeof item === 'string') {
        return {
          word: item,
          count: 1,
        }
      }

      return {
        word:
          cleanText(item?.word),
        count:
          Math.max(
            1,
            Number(item?.count || 1)
          ),
      }
    })
    .filter((item) => item.word)
}

async function getMyAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  return data
}

async function getReviewCounts(authorPageId) {
  const { data, error } = await supabase
    .from('author_hidden_comment_reviews')
    .select('status')
    .eq(
      'author_page_id',
      String(authorPageId)
    )
    .limit(MAX_REVIEWS)

  if (error) throw error

  const counts = {
    hidden: 0,
    kept_hidden: 0,
    restored: 0,
    deleted: 0,
  }

  for (const item of data || []) {
    const status =
      VALID_STATUSES.has(item.status)
        ? item.status
        : 'hidden'

    counts[status] += 1
  }

  return counts
}

async function fetchMaps(reviews) {
  const commentIds = [
    ...new Set(
      reviews
        .map((item) => item.comment_id)
        .filter(Boolean)
    ),
  ]
  const readerIds = [
    ...new Set(
      reviews
        .map((item) => item.reader_user_id)
        .filter(Boolean)
    ),
  ]
  const storyIds = [
    ...new Set(
      reviews
        .map((item) => item.story_id)
        .filter(Boolean)
    ),
  ]
  const episodeIds = [
    ...new Set(
      reviews
        .map((item) => item.episode_id)
        .filter(Boolean)
    ),
  ]

  const [
    commentsResult,
    usersResult,
    storiesResult,
    episodesResult,
  ] = await Promise.all([
    commentIds.length
      ? supabase
          .from('comments')
          .select(
            'id, story_id, episode_id, user_id, text, is_hidden, deleted_at, created_at, updated_at'
          )
          .in('id', commentIds)
      : Promise.resolve({
          data: [],
          error: null,
        }),
    readerIds.length
      ? supabase
          .from('users')
          .select(
            'id, name, username, avatar_url'
          )
          .in('id', readerIds)
      : Promise.resolve({
          data: [],
          error: null,
        }),
    storyIds.length
      ? supabase
          .from('stories')
          .select(
            'id, title, cover_url'
          )
          .in('id', storyIds)
      : Promise.resolve({
          data: [],
          error: null,
        }),
    episodeIds.length
      ? supabase
          .from('episodes')
          .select(
            'id, title, episode_number'
          )
          .in('id', episodeIds)
      : Promise.resolve({
          data: [],
          error: null,
        }),
  ])

  const firstError = [
    commentsResult.error,
    usersResult.error,
    storiesResult.error,
    episodesResult.error,
  ].find(Boolean)

  if (firstError) throw firstError

  return {
    comments: new Map(
      (commentsResult.data || []).map(
        (item) => [
          String(item.id),
          item,
        ]
      )
    ),
    users: new Map(
      (usersResult.data || []).map(
        (item) => [
          String(item.id),
          item,
        ]
      )
    ),
    stories: new Map(
      (storiesResult.data || []).map(
        (item) => [
          String(item.id),
          item,
        ]
      )
    ),
    episodes: new Map(
      (episodesResult.data || []).map(
        (item) => [
          String(item.id),
          item,
        ]
      )
    ),
  }
}

function buildPublicReview(review, maps) {
  const comment = maps.comments.get(
    String(review.comment_id)
  )
  const user = maps.users.get(
    String(review.reader_user_id)
  )
  const story = maps.stories.get(
    String(review.story_id)
  )
  const episode = review.episode_id
    ? maps.episodes.get(
        String(review.episode_id)
      )
    : null
  const status = comment?.deleted_at
    ? 'deleted'
    : VALID_STATUSES.has(review.status)
      ? review.status
      : 'hidden'

  return {
    id: review.id,
    review_id: review.id,
    status,
    comment_id:
      review.comment_id,
    story_id:
      review.story_id,
    episode_id:
      review.episode_id || null,
    reader_user_id:
      review.reader_user_id,
    text:
      comment?.text ||
      review.comment_text ||
      '',
    comment_text:
      comment?.text ||
      review.comment_text ||
      '',
    matched_words:
      publicMatchedWords(
        review.matched_words
      ),
    created_at:
      review.created_at,
    reviewed_at:
      review.reviewed_at || null,
    is_hidden:
      Boolean(comment?.is_hidden),
    is_deleted:
      Boolean(comment?.deleted_at),
    reader:
      publicUser(
        user,
        review.reader_user_id
      ),
    story:
      publicStory(
        story,
        review.story_id
      ),
    episode:
      publicEpisode(
        episode,
        review.episode_id
      ),
  }
}

function matchesSearch(item, search) {
  if (!search) return true

  const values = [
    item.text,
    item.reader?.name,
    item.reader?.username,
    item.story?.title,
    item.episode?.title,
    item.episode?.episode_number,
    ...item.matched_words.map(
      (word) => word.word
    ),
  ]

  return values.some((value) =>
    String(value || '')
      .toLowerCase()
      .includes(search)
  )
}

function statusHttpCode(code) {
  if (
    code === 'REVIEW_NOT_FOUND' ||
    code === 'COMMENT_NOT_FOUND'
  ) {
    return 404
  }

  if (code === 'COMMENT_DELETED') {
    return 409
  }

  return 400
}

export async function getMyAuthorHiddenComments(
  req,
  res
) {
  try {
    const userId =
      req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message:
          'Author page not found',
      })
    }

    const page =
      normalizePage(req.query.page)
    const limit =
      normalizeLimit(req.query.limit)
    const status =
      normalizeStatus(req.query.status)
    const sort =
      normalizeSort(req.query.sort)
    const search =
      cleanText(
        req.query.search ||
        req.query.q
      ).toLowerCase()

    const { data, error } =
      await supabase
        .from(
          'author_hidden_comment_reviews'
        )
        .select('*')
        .eq(
          'author_page_id',
          String(authorPage.id)
        )
        .eq(
          'author_user_id',
          String(userId)
        )
        .order(
          'created_at',
          {
            ascending:
              sort === 'oldest',
          }
        )
        .limit(MAX_REVIEWS)

    if (error) throw error

    const reviews = data || []
    const maps =
      await fetchMaps(reviews)
    const publicReviews =
      reviews.map((item) =>
        buildPublicReview(
          item,
          maps
        )
      )
    const counts = {
      hidden: 0,
      kept_hidden: 0,
      restored: 0,
      deleted: 0,
    }

    for (const item of publicReviews) {
      counts[item.status] += 1
    }

    const filtered =
      publicReviews.filter(
        (item) =>
          item.status === status &&
          matchesSearch(
            item,
            search
          )
      )
    const total =
      filtered.length
    const totalPages =
      Math.max(
        1,
        Math.ceil(total / limit)
      )
    const safePage =
      Math.min(page, totalPages)
    const from =
      (safePage - 1) * limit
    const comments =
      filtered.slice(
        from,
        from + limit
      )

    return res.status(200).json({
      ok: true,
      page: safePage,
      limit,
      total,
      total_pages:
        totalPages,
      status,
      sort,
      counts,
      comments,
    })
  } catch (error) {
    console.error(
      'GET AUTHOR HIDDEN COMMENTS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load hidden comments',
      error: error.message,
    })
  }
}

export async function reviewMyAuthorHiddenComment(
  req,
  res
) {
  try {
    const userId =
      req.user?.user_id
    const reviewId =
      cleanText(
        req.params.reviewId
      )
    const action =
      cleanText(
        req.body?.action
      ).toLowerCase()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!reviewId) {
      return res.status(400).json({
        ok: false,
        message:
          'Review id is required',
      })
    }

    if (
      ![
        'keep_hidden',
        'restore',
        'delete',
      ].includes(action)
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Action is not valid',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message:
          'Author page not found',
      })
    }

    const {
      data: review,
      error: reviewError,
    } = await supabase
      .from(
        'author_hidden_comment_reviews'
      )
      .select('*')
      .eq('id', reviewId)
      .eq(
        'author_page_id',
        String(authorPage.id)
      )
      .eq(
        'author_user_id',
        String(userId)
      )
      .maybeSingle()

    if (reviewError) {
      throw reviewError
    }

    if (!review) {
      return res.status(404).json({
        ok: false,
        message:
          'Hidden comment review not found',
      })
    }

    if (action === 'delete') {
      const result =
        await deleteStoryCommentToTrash({
          commentId:
            review.comment_id,
          actorType: 'author',
          actorId:
            String(userId),
          reason:
            'Deleted from Author Hidden Comments',
        })

      if (!result.ok) {
        const httpStatus =
          getCommentTrashStatus(
            result
          )

        if (
          result.retry_after_seconds
        ) {
          res.setHeader(
            'Retry-After',
            String(
              result.retry_after_seconds
            )
          )
        }

        return res
          .status(httpStatus)
          .json({
            ok: false,
            code: result.code,
            message:
              getCommentTrashMessage(
                result
              ),
            retry_after_seconds:
              result.retry_after_seconds ||
              0,
          })
      }

      const {
        error: updateError,
      } = await supabase
        .from(
          'author_hidden_comment_reviews'
        )
        .update({
          status: 'deleted',
          reviewed_at:
            new Date().toISOString(),
        })
        .eq('id', review.id)
        .eq(
          'author_user_id',
          String(userId)
        )

            if (updateError) {
        throw updateError
      }

      await saveAuthorCommentActivityLogSafely({
        authorPageId:
          String(authorPage.id),
        authorUserId:
          String(userId),
        actorType: 'author',
        actorUserId:
          String(userId),
        actionType:
          'comment_deleted',
        targetType: 'comment',
        targetId:
          review.comment_id,
        summary:
          'Moved a hidden comment to Trash',
        metadata: {
          review_id:
            review.id,
          story_id:
            review.story_id,
          episode_id:
            review.episode_id ||
            null,
          reader_user_id:
            review.reader_user_id,
        },
      })

      return res.status(200).json({
        ok: true,
        message:
          'Comment moved to trash',
        review_id:
          review.id,
        comment_id:
          review.comment_id,
        status: 'deleted',
        counts:
          await getReviewCounts(
            authorPage.id
          ),
      })
    }

    const {
      data,
      error,
    } = await supabase.rpc(
      'author_review_hidden_comment',
      {
        p_author_user_id:
          String(userId),
        p_review_id:
          review.id,
        p_action:
          action,
      }
    )

    if (error) throw error

    const result =
      normalizeRpcResult(data)

    if (!result.ok) {
      return res
        .status(
          statusHttpCode(
            result.code
          )
        )
        .json({
          ok: false,
          code: result.code,
          message:
            result.message ||
            'Failed to update hidden comment',
        })
    }

    await saveAuthorCommentActivityLogSafely({
      authorPageId:
        String(authorPage.id),
      authorUserId:
        String(userId),
      actorType: 'author',
      actorUserId:
        String(userId),
      actionType:
        action === 'restore'
          ? 'comment_restored'
          : 'comment_kept_hidden',
      targetType: 'comment',
      targetId:
        review.comment_id,
      summary:
        action === 'restore'
          ? 'Restored a hidden comment'
          : 'Kept a comment hidden',
      metadata: {
        review_id:
          review.id,
        story_id:
          review.story_id,
        episode_id:
          review.episode_id ||
          null,
        reader_user_id:
          review.reader_user_id,
      },
    })

    return res.status(200).json({
      ...result,
      message:
        action === 'restore'
          ? 'Comment restored'
          : 'Comment kept hidden',
      counts:
        await getReviewCounts(
          authorPage.id
        ),
    })
  } catch (error) {
    console.error(
      'REVIEW AUTHOR HIDDEN COMMENT ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to update hidden comment',
      error: error.message,
    })
  }
}
