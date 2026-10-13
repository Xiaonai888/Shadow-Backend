import { supabase } from '../config/supabase.js'
import { processStoryEpisodePushOnce } from './storyEpisodePushWorker.js'

const IDLE_CHECK_MS = 10 * 60 * 1000
const ACTIVE_CHECK_MS = 1000
const ERROR_CHECK_MS = 60 * 1000
const MAX_ERROR_CHECK_MS = 30 * 60 * 1000

let started = false
let running = false
let timer = null
let timerDueAt = 0
let wakeRequested = false
let consecutiveFailures = 0

function enabled() {
  return process.env.STORY_EPISODE_PUSH_ENABLED === 'true'
    && Boolean(String(process.env.ONESIGNAL_APP_ID || '').trim())
    && Boolean(String(process.env.ONESIGNAL_REST_API_KEY || '').trim())
}

function schedule(delayMs) {
  if (!started || !enabled()) return

  const dueAt = Date.now() + Math.max(0, delayMs)
  if (timer && timerDueAt <= dueAt) return

  if (timer) clearTimeout(timer)
  timerDueAt = dueAt
  timer = setTimeout(() => {
    timer = null
    timerDueAt = 0
    void processQueue()
  }, Math.max(0, dueAt - Date.now()))
  timer.unref?.()
}

async function getNextQueueDelay() {
  const { data, error } = await supabase.rpc('get_story_episode_push_next_due_at')
  if (error) throw error
  if (!data) return IDLE_CHECK_MS

  const nextDueAt = Date.parse(data)
  if (!Number.isFinite(nextDueAt)) return IDLE_CHECK_MS

  return Math.max(
    ACTIVE_CHECK_MS,
    Math.min(IDLE_CHECK_MS, nextDueAt - Date.now() + 1000)
  )
}

async function processQueue() {
  if (!started || !enabled()) return
  if (running) {
    wakeRequested = true
    return
  }

  running = true
  let delayMs = IDLE_CHECK_MS
  let checkNextDueAt = false

  try {
    for (let i = 0; i < 8; i += 1) {
      const result = await processStoryEpisodePushOnce()
      if (result?.idle || result?.skipped) {
        checkNextDueAt = Boolean(result?.idle)
        break
      }

      if (result?.retry) {
        checkNextDueAt = true
        break
      }

      delayMs = ACTIVE_CHECK_MS
    }

    if (checkNextDueAt) {
      delayMs = await getNextQueueDelay()
    }

    consecutiveFailures = 0
  } catch (error) {
    consecutiveFailures = Math.min(consecutiveFailures + 1, 6)
    delayMs = Math.min(
      MAX_ERROR_CHECK_MS,
      ERROR_CHECK_MS * 2 ** (consecutiveFailures - 1)
    )
    console.error('STORY EPISODE PUSH SCHEDULER ERROR:', error?.message || error)
  } finally {
    running = false
    const nextDelay = wakeRequested ? 0 : delayMs
    wakeRequested = false
    schedule(nextDelay)
  }
}

export function wakeStoryEpisodePushScheduler() {
  if (!started || !enabled()) return false

  if (running) {
    wakeRequested = true
  } else {
    schedule(100)
  }

  return true
}

export function startStoryEpisodePushScheduler() {
  if (started || !enabled()) return false

  started = true
  schedule(2000)
  return true
}
