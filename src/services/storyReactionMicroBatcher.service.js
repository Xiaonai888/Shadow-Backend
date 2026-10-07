import { supabase } from '../config/supabase.js'
import { incrementAuthorPageAnalytics } from './authorAnalytics.service.js'

const MICRO_BATCH_WINDOW_MS = 150
const MICRO_BATCH_MAX_ITEMS = 500

const pendingByKey = new Map()
let pendingWaiters = []
let flushTimer = null
let flushRunning = false

function eventKey(userId, storyId) {
  return `${userId}:${storyId}`
}

function eventTimestamp(event) {
  const value = Date.parse(
    String(event?.occurred_at || '')
  )

  return Number.isFinite(value)
    ? value
    : 0
}

function isNewerEvent(next, current) {
  if (!current) return true

  const nextTime =
    eventTimestamp(next)

  const currentTime =
    eventTimestamp(current)

  if (nextTime !== currentTime) {
    return nextTime > currentTime
  }

  return String(
    next?.event_id || ''
  ) > String(
    current?.event_id || ''
  )
}

function clearFlushTimer() {
  if (!flushTimer) return

  clearTimeout(flushTimer)
  flushTimer = null
}

function scheduleFlush(delay = MICRO_BATCH_WINDOW_MS) {
  if (flushRunning) return

  clearFlushTimer()

  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPending()
  }, Math.max(0, delay))
}

async function recordAnalytics(results) {
  const byAuthor = new Map()

  for (const item of results) {
    if (
      item?.ok !== true ||
      item?.action !== 'added' ||
      !item?.author_id ||
      String(item?.owner_user_id || '') ===
        String(item?.user_id || '')
    ) {
      continue
    }

    const authorId =
      String(item.author_id)

    byAuthor.set(
      authorId,
      Number(
        byAuthor.get(authorId) || 0
      ) + 1
    )
  }

  await Promise.allSettled(
    [...byAuthor.entries()].map(
      ([authorId, amount]) =>
        incrementAuthorPageAnalytics(
          authorId,
          'interactions',
          amount
        )
    )
  )
}

async function flushPending() {
  if (
    flushRunning ||
    !pendingByKey.size
  ) {
    return
  }

  flushRunning = true
  clearFlushTimer()

  const items = [
    ...pendingByKey.values(),
  ]

  pendingByKey.clear()

  const waiters =
    pendingWaiters

  pendingWaiters = []

  try {
    const {
      data,
      error,
    } = await supabase.rpc(
      'apply_story_reaction_states_multi_batch',
      {
        p_items: items,
      }
    )

    if (error) throw error

    const results =
      Array.isArray(data)
        ? data
        : []

    const resultByKey =
      new Map()

    for (const item of results) {
      if (
        !item?.user_id ||
        !item?.story_id
      ) {
        continue
      }

      resultByKey.set(
        eventKey(
          item.user_id,
          item.story_id
        ),
        item
      )
    }

    for (const waiter of waiters) {
      const waiterResults =
        waiter.keys.map(
          (key) =>
            resultByKey.get(key)
        )

      if (
        waiterResults.some(
          (item) => !item
        )
      ) {
        waiter.reject(
          new Error(
            'Reaction batch result is incomplete'
          )
        )
        continue
      }

      waiter.resolve({
        results:
          waiterResults,
        processed_at:
          new Date().toISOString(),
      })
    }

    void recordAnalytics(
      results
    )
  } catch (error) {
    for (const waiter of waiters) {
      waiter.reject(error)
    }
  } finally {
    flushRunning = false

    if (pendingByKey.size) {
      scheduleFlush(
        pendingByKey.size >=
          MICRO_BATCH_MAX_ITEMS
          ? 0
          : MICRO_BATCH_WINDOW_MS
      )
    }
  }
}

export function enqueueStoryReactionBatch({
  userId,
  events,
}) {
  const safeUserId =
    String(userId || '').trim()

  const safeEvents =
    Array.isArray(events)
      ? events
      : []

  if (
    !safeUserId ||
    !safeEvents.length
  ) {
    return Promise.resolve({
      results: [],
      processed_at:
        new Date().toISOString(),
    })
  }

  const keys = []

  for (const event of safeEvents) {
    const storyId =
      String(
        event?.story_id || ''
      ).trim()

    if (!storyId) continue

    const key =
      eventKey(
        safeUserId,
        storyId
      )

    const next = {
      ...event,
      user_id:
        safeUserId,
      story_id:
        storyId,
    }

    const current =
      pendingByKey.get(key)

    if (
      isNewerEvent(
        next,
        current
      )
    ) {
      pendingByKey.set(
        key,
        next
      )
    }

    if (!keys.includes(key)) {
      keys.push(key)
    }
  }

  if (!keys.length) {
    return Promise.resolve({
      results: [],
      processed_at:
        new Date().toISOString(),
    })
  }

  const promise =
    new Promise(
      (resolve, reject) => {
        pendingWaiters.push({
          keys,
          resolve,
          reject,
        })
      }
    )

  if (
    pendingByKey.size >=
    MICRO_BATCH_MAX_ITEMS
  ) {
    scheduleFlush(0)
  } else {
    scheduleFlush()
  }

  return promise
}
