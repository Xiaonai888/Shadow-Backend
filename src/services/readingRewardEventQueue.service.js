import { supabase } from '../config/supabase.js'

const READING_EVENT_FLUSH_MS = 5 * 1000
const READING_EVENT_RETRY_MS = 5 * 1000
const READING_EVENT_BATCH_SIZE = 200
const READING_EVENT_QUEUE_LIMIT = 10000

let readingEventQueue = []
let readingEventTimer = null
let readingEventFlushPromise = null

function scheduleReadingEventFlush(
  delay = READING_EVENT_FLUSH_MS
) {
  if (
    readingEventTimer ||
    readingEventFlushPromise ||
    !readingEventQueue.length
  ) {
    return
  }

  readingEventTimer =
    setTimeout(() => {
      readingEventTimer = null
      void flushReadingRewardEvents()
    }, Math.max(0, delay))

  readingEventTimer.unref?.()
}

function normalizeReadingEvent(event) {
  const secondsAdded = Math.max(
    0,
    Math.floor(
      Number(event?.seconds_added || 0)
    )
  )

  if (
    !event?.user_id ||
    !event?.reward_date ||
    secondsAdded <= 0
  ) {
    return null
  }

  return {
    user_id: event.user_id,
    reward_date: event.reward_date,
    story_id: event.story_id || null,
    episode_id: event.episode_id || null,
    seconds_added: secondsAdded,
    active_seconds_after: Math.max(
      0,
      Math.floor(
        Number(
          event.active_seconds_after || 0
        )
      )
    ),
    event_type:
      event.event_type || 'heartbeat',
  }
}

export function queueReadingRewardEvent(
  event
) {
  const normalized =
    normalizeReadingEvent(event)

  if (!normalized) {
    return false
  }

  if (
    readingEventQueue.length >=
    READING_EVENT_QUEUE_LIMIT
  ) {
    console.error(
      'READING_REWARD_EVENT_QUEUE_FULL',
      readingEventQueue.length
    )
    return false
  }

  readingEventQueue.push(normalized)

  if (
    readingEventQueue.length >=
    READING_EVENT_BATCH_SIZE
  ) {
    if (readingEventTimer) {
      clearTimeout(readingEventTimer)
      readingEventTimer = null
    }

    void flushReadingRewardEvents()
  } else {
    scheduleReadingEventFlush()
  }

  return true
}

export async function flushReadingRewardEvents() {
  if (readingEventFlushPromise) {
    return readingEventFlushPromise
  }

  if (!readingEventQueue.length) {
    return true
  }

  if (readingEventTimer) {
    clearTimeout(readingEventTimer)
    readingEventTimer = null
  }

  const batch =
    readingEventQueue.splice(
      0,
      READING_EVENT_BATCH_SIZE
    )

  const request = (async () => {
    const { error } = await supabase
      .from(
        'reader_reading_reward_events'
      )
      .insert(batch)

    if (error) {
      readingEventQueue = [
        ...batch,
        ...readingEventQueue,
      ].slice(
        0,
        READING_EVENT_QUEUE_LIMIT
      )

      console.error(
        'READING_REWARD_EVENT_BATCH_ERROR:',
        error
      )

      return false
    }

    return true
  })()

  readingEventFlushPromise = request

  try {
    return await request
  } finally {
    if (
      readingEventFlushPromise === request
    ) {
      readingEventFlushPromise = null
    }

    if (readingEventQueue.length) {
      scheduleReadingEventFlush(
        READING_EVENT_RETRY_MS
      )
    }
  }
}
