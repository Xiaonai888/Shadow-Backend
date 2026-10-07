import { randomUUID } from 'node:crypto'
import { supabase } from '../config/supabase.js'

const COMMENT_BATCH_WINDOW_MS = 120
const COMMENT_BATCH_MAX_ITEMS = 200

let pending = []
let flushTimer = null
let flushRunning = false

function clearFlushTimer() {
  if (!flushTimer) return
  clearTimeout(flushTimer)
  flushTimer = null
}

function scheduleFlush(delay = COMMENT_BATCH_WINDOW_MS) {
  if (flushRunning || flushTimer) return

  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPending()
  }, Math.max(0, delay))
}

async function flushPending() {
  if (flushRunning || !pending.length) {
    return
  }

  flushRunning = true
  clearFlushTimer()

  const batch = pending.splice(
    0,
    COMMENT_BATCH_MAX_ITEMS
  )

  try {
    const { data, error } =
      await supabase.rpc(
        'create_story_comments_multi_batch_once',
        {
          p_items: batch.map(
            ({ resolve, reject, ...item }) =>
              item
          ),
        }
      )

    if (error) throw error

    const results =
      Array.isArray(data?.items)
        ? data.items
        : []

    const byRequestKey =
      new Map(
        results
          .filter(
            (item) =>
              item?.request_key
          )
          .map(
            (item) => [
              String(item.request_key),
              item,
            ]
          )
      )

    for (const item of batch) {
      const result =
        byRequestKey.get(
          item.request_key
        )

      if (!result) {
        item.reject(
          new Error(
            'Comment batch result is incomplete'
          )
        )
        continue
      }

      if (result.ok !== true) {
        const error =
          new Error(
            result.message ||
            'Comment creation failed'
          )

        error.code =
          'COMMENT_BATCH_ITEM_FAILED'

        item.reject(error)
        continue
      }

      item.resolve(result)
    }
  } catch (error) {
    for (const item of batch) {
      item.reject(error)
    }
  } finally {
    flushRunning = false

    if (pending.length) {
      scheduleFlush(
        pending.length >=
          COMMENT_BATCH_MAX_ITEMS
          ? 0
          : COMMENT_BATCH_WINDOW_MS
      )
    }
  }
}

export function enqueueCommentCreate({
  storyId,
  episodeId = null,
  userId,
  parentId = null,
  text,
  isHidden = false,
  clientEventId = null,
  occurredAt = null,
}) {
  const requestKey =
    randomUUID()

  const promise =
    new Promise(
      (resolve, reject) => {
        pending.push({
          request_key:
            requestKey,
          story_id:
            storyId,
          episode_id:
            episodeId,
          user_id:
            userId,
          parent_id:
            parentId,
          text,
          is_hidden:
            Boolean(isHidden),
          client_event_id:
            clientEventId,
          occurred_at:
            occurredAt,
          resolve,
          reject,
        })
      }
    )

  if (
    pending.length >=
    COMMENT_BATCH_MAX_ITEMS
  ) {
    clearFlushTimer()
    void flushPending()
  } else {
    scheduleFlush()
  }

  return promise
}
