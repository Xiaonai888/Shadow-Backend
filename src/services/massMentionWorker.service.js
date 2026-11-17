import { supabase } from '../config/supabase.js'
import { processMassMentionJob } from './massMentionJob.service.js'

const IDLE_POLL_MS = 120000
const ACTIVE_POLL_MS = 8000
const MIN_WAKE_MS = 400
const MAX_RETRIES = 8
let running = false
let enabled = false
let timer = null

function schedule(delay) {
  if (!enabled) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void runOnce()
  }, delay)
  timer.unref?.()
}

async function releaseFailedJob(job, error) {
  const attempts = Number(job.attempts || 0)
  const failed = attempts >= MAX_RETRIES
  const retryDelay = Math.min(1800000, 30000 * 2 ** Math.max(0, attempts - 1))
  const { error: saveError } = await supabase.from('mass_mention_jobs')
    .update({
      status: failed ? 'failed' : 'pending',
      locked_at: null,
      updated_at: new Date().toISOString(),
      available_at: new Date(Date.now() + retryDelay).toISOString(),
    })
    .eq('id', job.id)
    .eq('status', 'processing')
    .eq('locked_at', job.locked_at)
  if (saveError) console.error('MASS_MENTION_JOB_RELEASE_ERROR', saveError.message)
  console.error('MASS_MENTION_JOB_ERROR', {
    id: job.id,
    attempts,
    failed,
    message: String(error?.message || error).slice(0, 200),
  })
}

export async function runMassMentionWorkerOnce() {
  if (running) return false
  running = true
  let job = null
  try {
    const { data, error } = await supabase.rpc('mass_mention_claim_job')
    if (error) throw error
    job = Array.isArray(data) ? data[0] || null : data || null
    if (!job) return false
    await processMassMentionJob({ job })
    return true
  } catch (error) {
    if (job) {
      await releaseFailedJob(job, error)
    } else {
      console.error('MASS_MENTION_CLAIM_ERROR', String(error?.message || error).slice(0, 200))
    }
    return Boolean(job)
  } finally {
    running = false
  }
}

async function runOnce() {
  if (!enabled) return
  const hadWork = await runMassMentionWorkerOnce()
  if (enabled) schedule(hadWork ? ACTIVE_POLL_MS : IDLE_POLL_MS)
}

export function startMassMentionWorker() {
  if (enabled) return
  enabled = true
  schedule(MIN_WAKE_MS)
}

export function wakeMassMentionWorker() {
  if (!enabled || running) return
  schedule(MIN_WAKE_MS)
}

export function stopMassMentionWorker() {
  enabled = false
  if (timer) clearTimeout(timer)
  timer = null
}
