import { randomUUID } from 'node:crypto'
import { supabase } from '../config/supabase.js'
import { incrementAuthorPageAnalytics } from '../services/authorAnalytics.service.js'
import { markRequestDiagnostic } from '../services/trafficDiagnostic.service.js'
import { enqueueStoryReactionBatch } from '../services/storyReactionMicroBatcher.service.js'

const STORY_REACTION_TYPES = new Set([
  'love',
  'haha',
  'wow',
  'sad',
  'angry',
  'support',
  'touched',
])

const REACTION_DIAGNOSTIC_CODES = {
  story_lookup: 'REACTION_STORY_LOOKUP_FAILED',
  reaction_lookup: 'REACTION_LOOKUP_FAILED',
  update: 'REACTION_UPDATE_FAILED',
  delete: 'REACTION_DELETE_FAILED',
  insert: 'REACTION_INSERT_FAILED',
  total_sync: 'REACTION_TOTAL_SYNC_FAILED',
  analytics: 'REACTION_ANALYTICS_FAILED',
}

function markStoryReactionDiagnostic(details = {}) {
  return markRequestDiagnostic({
    feature: 'story_reaction_toggle',
    ...details,
  })
}

function normalizeReactionType(value) {
  const reactionType = String(value || 'love')
    .trim()
    .toLowerCase()

  return STORY_REACTION_TYPES.has(reactionType)
    ? reactionType
    : 'love'
}

function getOptionalReader(req) {
  try {
    const user = req.user || null

    if (!user?.user_id) return null

    return user
  } catch {
    return null
  }
}

async function getStory(storyId) {
  const { data, error } = await supabase
    .from('stories')
    .select('id, author_id, user_id, title, total_likes')
    .eq('id', storyId)
    .maybeSingle()

  if (error) throw error

  return data
}

async function countStoryReactions(storyId) {
  const { count, error } = await supabase
    .from('story_reactions')
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('story_id', storyId)
    .is('episode_id', null)

  if (error) throw error

  return Number(count || 0)
}

async function syncStoryTotalLikes(storyId) {
  const totalLikes =
    await countStoryReactions(storyId)
  
  const { error } = await supabase
    .from('stories')
    .update({
      total_likes: totalLikes,
      updated_at: new Date().toISOString(),
    })
    .eq('id', storyId)

  if (error) throw error

  return totalLikes
}

export async function getStoryReactionStatus(
  req,
  res
) {
  try {
    const storyId = String(
      req.params.storyId || ''
    ).trim()
    const user = getOptionalReader(req)
    const story = await getStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    let myReaction = null

    if (user?.user_id) {
      const { data, error } = await supabase
        .from('story_reactions')
        .select(
          'id, reaction_type, created_at'
        )
        .eq('story_id', storyId)
        .eq('user_id', user.user_id)
        .is('episode_id', null)
        .maybeSingle()

      if (error) throw error
      myReaction = data || null
    }

   const totalLikes = Number(story.total_likes || 0)

    return res.status(200).json({
      ok: true,
      story_id: storyId,
      liked: Boolean(myReaction),
      reaction_type:
        myReaction?.reaction_type || null,
      total_likes: totalLikes,
    })
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load reaction status',
    })
  }
}

export async function getStoryReactions(
  req,
  res
) {
  try {
    const storyId = String(
      req.params.storyId || ''
    ).trim()
    const page = Math.max(
      1,
      Number(req.query.page || 1)
    )
    const limit = Math.min(
      100,
      Math.max(
        1,
        Number(req.query.limit || 50)
      )
    )
    const from = (page - 1) * limit
    const to = from + limit - 1
    const story = await getStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const {
      data: countRows,
      error: countError,
    } = await supabase
      .from('story_reactions')
      .select('reaction_type')
      .eq('story_id', storyId)
      .is('episode_id', null)

    if (countError) throw countError

    const counts = (countRows || []).reduce(
      (result, item) => {
        const type = normalizeReactionType(
          item.reaction_type
        )

        result[type] =
          Number(result[type] || 0) + 1

        return result
      },
      {}
    )

    const {
      data,
      error,
      count,
    } = await supabase
      .from('story_reactions')
      .select(
        'id, user_id, reaction_type, created_at, user:users(id, name, username, avatar_url)',
        { count: 'exact' }
      )
      .eq('story_id', storyId)
      .is('episode_id', null)
      .order('created_at', {
        ascending: false,
      })
      .range(from, to)

    if (error) throw error

    const reactions = (data || []).map(
      (item) => {
        const user = Array.isArray(item.user)
          ? item.user[0]
          : item.user

        return {
          id: item.id,
          reaction_type:
            normalizeReactionType(
              item.reaction_type
            ),
          created_at: item.created_at,
          user: {
            id: user?.id || item.user_id,
            name:
              user?.name ||
              user?.username ||
              'Reader',
            username: user?.username || '',
            avatar_url:
              user?.avatar_url || '',
          },
        }
      }
    )

    const total = Number(count || 0)

    return res.status(200).json({
      ok: true,
      story: {
        id: story.id,
        title: story.title || '',
      },
      total,
      counts,
      page,
      limit,
      has_more: to + 1 < total,
      reactions,
    })
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load story reactions',
    })
  }
}


const STORY_REACTION_BATCH_LIMIT = 200
const STORY_REACTION_MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000
const STORY_REACTION_MAX_FUTURE_MS = 5 * 60 * 1000
const STORY_REACTION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function normalizeBatchOccurredAt(value) {
  const parsed = Date.parse(
    String(value || '')
  )
  const now = Date.now()

  if (!Number.isFinite(parsed)) {
    return new Date(now).toISOString()
  }

  if (
    parsed < now - STORY_REACTION_MAX_PAST_MS ||
    parsed > now + STORY_REACTION_MAX_FUTURE_MS
  ) {
    return new Date(now).toISOString()
  }

  return new Date(parsed).toISOString()
}

function normalizeBatchEventId(value) {
  const eventId = String(value || '').trim()

  return STORY_REACTION_UUID_PATTERN.test(eventId)
    ? eventId
    : null
}

async function handleStoryReactionBatch(req, res) {
  try {
    const userId = String(
      req.user?.user_id || ''
    ).trim()
    const inputEvents = Array.isArray(
      req.body?.events
    )
      ? req.body.events
      : []

    if (!STORY_REACTION_UUID_PATTERN.test(userId)) {
      return res.status(401).json({
        ok: false,
        message: 'Login is required',
      })
    }

    if (!inputEvents.length) {
      return res.status(200).json({
        ok: true,
        batch: true,
        results: [],
        processed_at: new Date().toISOString(),
      })
    }

    if (inputEvents.length > STORY_REACTION_BATCH_LIMIT) {
      return res.status(400).json({
        ok: false,
        message: `A maximum of ${STORY_REACTION_BATCH_LIMIT} reaction events is allowed per batch`,
      })
    }

    const finalByStory = new Map()

    for (const item of inputEvents) {
      const storyId = String(
        item?.story_id || ''
      ).trim()

      if (!STORY_REACTION_UUID_PATTERN.test(storyId)) {
        continue
      }

      finalByStory.set(storyId, {
        story_id: storyId,
        event_id: normalizeBatchEventId(
          item?.event_id
        ),
        liked: item?.liked === true,
        reaction_type: normalizeReactionType(
          item?.reaction_type
        ),
        occurred_at: normalizeBatchOccurredAt(
          item?.occurred_at
        ),
      })
    }

    const events = [...finalByStory.values()]

    if (!events.length) {
      return res.status(400).json({
        ok: false,
        message: 'No valid reaction events were provided',
      })
    }

    markRequestDiagnostic({
      feature: 'story_reaction_micro_batch',
      stage: 'queued',
      event_count: inputEvents.length,
      final_event_count: events.length,
      status: 'running',
    })

    const data = await enqueueStoryReactionBatch({
      userId,
      events,
    })

    markRequestDiagnostic({
      feature: 'story_reaction_micro_batch',
      stage: 'complete',
      event_count: inputEvents.length,
      final_event_count: events.length,
      status: 'ok',
    })

    const results = Array.isArray(data?.results)
      ? data.results
      : []

    return res.status(200).json({
      ok: true,
      batch: true,
      results: results.map(
        ({
          author_id,
          owner_user_id,
          user_id,
          ...item
        }) => item
      ),
      processed_at:
        data?.processed_at ||
        new Date().toISOString(),
    })
  } catch (error) {
    markRequestDiagnostic({
      feature: 'story_reaction_micro_batch',
      stage: 'failed',
      status: 'error',
      provider_code: error?.code || '',
    })

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to update reaction batch',
    })
  }
}

export async function toggleStoryReaction(
  req,
  res
) {
  if (
    String(req.params.storyId || '')
      .trim()
      .toLowerCase() === 'batch'
  ) {
    return handleStoryReactionBatch(req, res)
  }

  try {
    const storyId = String(
      req.params.storyId || ''
    ).trim()

    const userId = String(
      req.user?.user_id || ''
    ).trim()

    const reactionType =
      normalizeReactionType(
        req.body?.reaction_type
      )

    if (
      !STORY_REACTION_UUID_PATTERN.test(
        userId
      )
    ) {
      return res.status(401).json({
        ok: false,
        message: 'Login is required',
      })
    }

    if (
      !STORY_REACTION_UUID_PATTERN.test(
        storyId
      )
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid story ID',
      })
    }

    const story =
      await getStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const {
      data: existing,
      error: existingError,
    } = await supabase
      .from('story_reactions')
      .select('id, reaction_type')
      .eq('story_id', storyId)
      .eq('user_id', userId)
      .is('episode_id', null)
      .maybeSingle()

    if (existingError) {
      throw existingError
    }

    const existingType =
      existing
        ? normalizeReactionType(
            existing.reaction_type
          )
        : null

    const liked =
      !existing ||
      existingType !==
        reactionType

    const data =
      await enqueueStoryReactionBatch({
        userId,
        events: [
          {
            story_id:
              storyId,
            event_id:
              randomUUID(),
            liked,
            reaction_type:
              reactionType,
            occurred_at:
              new Date().toISOString(),
          },
        ],
      })

    const result =
      Array.isArray(
        data?.results
      )
        ? data.results[0]
        : null

    if (
      !result ||
      result.ok === false
    ) {
      return res.status(500).json({
        ok: false,
        message:
          result?.message ||
          'Failed to update reaction',
      })
    }

    return res.status(200).json({
      ok: true,
      action:
        result.action ||
        (
          liked
            ? existing
              ? 'updated'
              : 'added'
            : 'removed'
        ),
      liked:
        Boolean(result.liked),
      reaction_type:
        result.liked
          ? (
              result.reaction_type ||
              reactionType
            )
          : null,
      total_likes:
        Math.max(
          0,
          Number(
            result.total_likes ||
            0
          )
        ),
      processed_at:
        result.processed_at ||
        data?.processed_at ||
        new Date().toISOString(),
    })
  } catch (error) {
    markRequestDiagnostic({
      feature:
        'story_reaction_toggle',
      stage:
        'failed',
      status:
        'error',
      provider_code:
        error?.code || '',
    })

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to update reaction',
    })
  }
}

