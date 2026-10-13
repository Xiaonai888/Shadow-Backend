import { supabase } from '../config/supabase.js'
import { sendAuthorStoryPushSafely } from './authorStoryPush.service.js'

const IDLE_CHECK_MS = 3 * 60 * 1000
const ACTIVE_CHECK_MS = 1200
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const BATCH_SIZE = 12
const CONCURRENCY = 3
let started = false
let running = false
let timer = null
let lastCleanupAt = 0
let wakeRequested = false

function enabled() {
  return String(process.env.AUTHOR_STORY_PUSH_QUEUE_ENABLED ?? 'true').toLowerCase() !== 'false'
}

function schedule(delay) {
  if (!started || !enabled()) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void processAuthorStoryPushQueue()
  }, delay)
  timer.unref?.()
}

async function processJob(job) {
  try {
    const sent = await sendAuthorStoryPushSafely(job.payload, { throwOnFailure: true })
    return { id: job.id, claim_token: job.claim_token, outcome: sent ? 'sent' : 'skipped', error: '' }
  } catch (error) {
    return {
      id: job.id,
      claim_token: job.claim_token,
      outcome: 'retry',
      error: String(error?.message || error).slice(0, 300),
    }
  }
}

async function cleanOldResults() {
  const now = Date.now()
  if (now - lastCleanupAt < 24 * 60 * 60 * 1000) return
  const cutoff = new Date(now - RETENTION_MS).toISOString()
  const { error } = await supabase
    .from('author_story_push_jobs')
    .delete()
    .in('status', ['sent', 'skipped'])
    .lt('updated_at', cutoff)
  if (error) throw error
  lastCleanupAt = now
}

async function processAuthorStoryPushQueue() {
  if (running || !started || !enabled()) return
  running = true
  let nextDelay = IDLE_CHECK_MS
  try {
    const { data, error } = await supabase.rpc('claim_author_story_push_jobs', { p_limit: BATCH_SIZE })
    if (error) throw error
    const jobs = Array.isArray(data) ? data : []
    if (jobs.length) {
      const results = []
      for (let index = 0; index < jobs.length; index += CONCURRENCY) {
        results.push(...await Promise.all(jobs.slice(index, index + CONCURRENCY).map(processJob)))
      }
      const { data: completed, error: finishError } = await supabase.rpc('finish_author_story_push_jobs', { p_results: results })
      if (finishError) throw finishError
      if (Number(completed) !== jobs.length) console.warn('AUTHOR STORY PUSH QUEUE FINISH COUNT', completed, jobs.length)
      nextDelay = jobs.length === BATCH_SIZE ? ACTIVE_CHECK_MS : IDLE_CHECK_MS
    }
    await cleanOldResults()
  } catch (error) {
    console.error('AUTHOR STORY PUSH QUEUE ERROR:', error?.message || error)
  } finally {
    running = false
    const delay = wakeRequested ? 50 : nextDelay
    wakeRequested = false
    schedule(delay)
  }
}

export function wakeAuthorStoryPushQueue() {
  if (!started || !enabled()) return
  if (running) {
    wakeRequested = true
    return
  }
  schedule(50)
}

export function startAuthorStoryPushQueue() {
  if (started || !enabled()) return
  started = true
  schedule(1000)
}
