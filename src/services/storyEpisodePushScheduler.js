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

async function processQueue() {
  if (!started || !enabled()) return
  if (running) {
    wakeRequested = true
    return
  }

  running = true
  let delayMs = IDLE_CHECK_MS

  try {
    for (let i = 0; i < 8; i += 1) {
      const result = await processStoryEpisodePushOnce()
      if (result?.idle || result?.skipped) break

      if (result?.retry) {
        delayMs = ERROR_CHECK_MS
        break
      }

      delayMs = ACTIVE_CHECK_MS
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
