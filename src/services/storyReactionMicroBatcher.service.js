import { supabase } from '../config/supabase.js'
import { incrementAuthorPageAnalytics } from './authorAnalytics.service.js'

const MICRO_BATCH_WINDOW_MS = 150
const MICRO_BATCH_MAX_ITEMS = 500

let pendingJobs = []
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

function scheduleFlush(
  delay = MICRO_BATCH_WINDOW_MS
) {
  if (flushRunning) return

  if (delay === 0) {
    clearFlushTimer()
  } else if (flushTimer) {
    return
  }

  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPending()
  }, Math.max(0, delay))
}

function takeNextBatch() {
  const jobs = []
  let eventCount = 0

  while (pendingJobs.length) {
    const next =
      pendingJobs[0]

    const nextCount =
      next.events.length

    if (
      jobs.length &&
      eventCount + nextCount >
        MICRO_BATCH_MAX_ITEMS
    ) {
      break
    }

    pendingJobs.shift()
    jobs.push(next)
    eventCount += nextCount

    if (
      eventCount >=
      MICRO_BATCH_MAX_ITEMS
    ) {
      break
    }
  }

  return jobs
}

function buildFinalEvents(jobs) {
  const finalByKey =
    new Map()

  for (const job of jobs) {
    for (const event of job.events) {
      const key =
        eventKey(
          event.user_id,
          event.story_id
        )

      const current =
        finalByKey.get(key)

      if (
        isNewerEvent(
          event,
          current
        )
      ) {
        finalByKey.set(
          key,
          event
        )
      }
    }
  }

  return [
    ...finalByKey.values(),
  ]
}

async function recordAnalytics(results) {
  const byAuthor = new Map()

  for (const item of results) {
    if (
      item?.ok !== true ||
      item?.action !== 'added' ||
      !item?.author_id ||
      String(
        item?.owner_user_id || ''
      ) ===
        String(
          item?.user_id || ''
        )
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
    !pendingJobs.length
  ) {
    return
  }

  flushRunning = true
  clearFlushTimer()

  const jobs =
    takeNextBatch()

  const items =
    buildFinalEvents(jobs)

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

    if (error) {
      throw error
    }

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

    for (const job of jobs) {
      const jobResults =
        job.events.map(
          (event) =>
            resultByKey.get(
              eventKey(
                event.user_id,
                event.story_id
              )
            )
        )

      if (
        jobResults.some(
          (item) => !item
        )
      ) {
        job.reject(
          new Error(
            'Reaction batch result is incomplete'
          )
        )
        continue
      }

      job.resolve({
        results:
          jobResults,
        processed_at:
          new Date().toISOString(),
      })
    }

    void recordAnalytics(
      results
    )
  } catch (error) {
    for (const job of jobs) {
      job.reject(error)
    }
  } finally {
    flushRunning = false

    if (pendingJobs.length) {
      scheduleFlush(
        pendingJobs.reduce(
          (total, job) =>
            total +
            job.events.length,
          0
        ) >=
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

  const normalizedEvents =
    safeEvents
      .map((event) => {
        const storyId =
          String(
            event?.story_id || ''
          ).trim()

        if (!storyId) {
          return null
        }

        return {
          ...event,
          user_id:
            safeUserId,
          story_id:
            storyId,
        }
      })
      .filter(Boolean)

  if (
    !safeUserId ||
    !normalizedEvents.length
  ) {
    return Promise.resolve({
      results: [],
      processed_at:
        new Date().toISOString(),
    })
  }

  const promise =
    new Promise(
      (resolve, reject) => {
        pendingJobs.push({
          events:
            normalizedEvents,
          resolve,
          reject,
        })
      }
    )

  const pendingEventCount =
    pendingJobs.reduce(
      (total, job) =>
        total +
        job.events.length,
      0
    )

  if (
    pendingEventCount >=
    MICRO_BATCH_MAX_ITEMS
  ) {
    scheduleFlush(0)
  } else {
    scheduleFlush()
  }

  return promise
}
