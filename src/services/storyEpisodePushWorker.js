import { supabase } from '../config/supabase.js'

const API_URL = 'https://api.onesignal.com/notifications'
const BATCH_RETRY_LIMIT = 8

function requireResult(result, operation) {
  if (result.error) {
    throw new Error(`${operation}: ${result.error.message}`)
  }
  return Array.isArray(result.data) ? result.data[0] || null : result.data
}

async function updateBatch(batch, patch) {
  const result = await supabase
    .from('story_episode_push_batches')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', batch.id)
    .eq('status', 'processing')
    .eq('attempts', batch.attempts)
    .select('id')
    .maybeSingle()

  if (result.error) throw new Error(result.error.message)
  if (!result.data) throw new Error('Push batch lease was lost')
}

async function finishJob(jobId) {
  return requireResult(
    await supabase.rpc('finish_story_episode_push_job', { p_job_id: jobId }),
    'finish push job'
  )
}

function retryAfterSeconds(response, attempt) {
  const value = response?.headers?.get('retry-after')
  const numeric = Number(value)
  const parsed = value ? Date.parse(value) : NaN
  const serverDelay = Number.isFinite(numeric) ? numeric
    : Number.isFinite(parsed) ? Math.max(0, (parsed - Date.now()) / 1000) : 0
  return Math.min(3600, Math.max(30, serverDelay, 30 * 2 ** Math.min(attempt - 1, 6)))
}

async function failBatch(batch, error, retryable = true, retryAfter = null) {
  const retry = retryable && batch.attempts < BATCH_RETRY_LIMIT
  const delay = retryAfter ?? retryAfterSeconds(null, batch.attempts)
  await updateBatch(batch, {
    status: retry ? 'queued' : 'failed',
    next_attempt_at: new Date(Date.now() + delay * 1000).toISOString(),
    lease_expires_at: null,
    last_error: String(error?.message || error).slice(0, 600),
  })
  if (!retry) {
    const failedJob = await supabase
      .from('story_episode_push_jobs')
      .update({ status: 'failed', last_error: String(error?.message || error).slice(0, 600), completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', batch.job_id)
      .eq('status', 'processing')
    if (failedJob.error) throw new Error(failedJob.error.message)

    const cancelledBatches = await supabase
      .from('story_episode_push_batches')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('job_id', batch.job_id)
      .eq('status', 'queued')
    if (cancelledBatches.error) throw new Error(cancelledBatches.error.message)
  }
  return { ok: false, retry, batch_id: batch.id }
}

function isNoPushRecipientsResponse(data) {
  const details = data?.errors ?? data?.message ?? ''
  const text = typeof details === 'string' ? details : JSON.stringify(details)
  return /all included players are not subscribed|no subscribed recipients|no recipients|no subscriptions found/i.test(text)
}

async function markBatchSent(batch, jobId, notificationId = null, acceptedCount = 0) {
  await updateBatch(batch, {
    status: 'sent',
    lease_expires_at: null,
    sent_at: new Date().toISOString(),
    onesignal_notification_id: notificationId,
    accepted_count: acceptedCount,
    last_error: null,
  })
  await finishJob(jobId)
  return { ok: true, batch_id: batch.id, sent: acceptedCount }
}

async function getEpisode(job) {
  const result = await supabase
    .from('episodes')
    .select('id, story_id, status, published_at, deleted_at, episode_number, story:stories(id, title, status, deleted_at)')
    .eq('id', job.episode_id)
    .eq('story_id', job.story_id)
    .maybeSingle()
  if (result.error) throw new Error(result.error.message)
  const episode = result.data
  const story = episode?.story
  if (!episode || !story || episode.status !== 'published'
      || story.status !== 'published' || episode.deleted_at || story.deleted_at
      || !episode.published_at || Date.parse(episode.published_at) > Date.now()) {
    return null
  }
  return { story, episode }
}

async function loadJob(batch) {
  const result = await supabase
    .from('story_episode_push_jobs')
    .select('id, story_id, episode_id, published_at, status')
    .eq('id', batch.job_id)
    .single()
  if (result.error) throw new Error(result.error.message)
  return result.data
}

async function sendBatch(batch, appId, apiKey) {
  const job = await loadJob(batch)
  const current = job.status === 'processing' ? await getEpisode(job) : null
  if (!current) {
    return failBatch(batch, new Error('Episode is not publicly available'), true, 300)
  }

  const eligibleResult = await supabase.rpc('eligible_story_episode_push_users', { p_batch_id: batch.id })
  if (eligibleResult.error) throw new Error(eligibleResult.error.message)
  const recipients = Array.isArray(eligibleResult.data) ? eligibleResult.data : []

  if (!recipients.length) {
    return markBatchSent(batch, job.id)
  }

  const { story, episode } = current
  try {
    const { error } = await supabase.rpc('record_story_episode_notification_batch', { p_batch_id: batch.id })
    if (error) throw error
  } catch (error) {
    console.error('RECORD STORY EPISODE UPDATES ERROR:', error?.message || error)
  }
  const link = `https://www.shadowerabook.site/story/${encodeURIComponent(job.story_id)}/episode/${encodeURIComponent(job.episode_id)}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  let response

  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Key ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        app_id: appId,
        target_channel: 'push',
        name: `Story Episode ${job.episode_id} ${batch.batch_index}`,
        idempotency_key: batch.idempotency_key,
        include_aliases: { external_id: recipients },
        headings: { en: `📖 ${String(story.title || 'Shadow').slice(0, 100)}` },
        contents: {
          en: `ភាគទី ${Number(episode.episode_number || 0)} បានចេញផ្សាយហើយ! ចុចដើម្បីអានឥឡូវនេះ។`,
        },
        url: link,
        data: { story_id: job.story_id, episode_id: job.episode_id },
      }),
    })
  } catch (error) {
    return failBatch(batch, error)
  } finally {
    clearTimeout(timeout)
  }

  const data = await response.json().catch(() => ({}))
  if (!data?.id && isNoPushRecipientsResponse(data)) {
    return markBatchSent(batch, job.id)
  }

  if (!response.ok) {
    const error = new Error(JSON.stringify(data?.errors || data?.message || `HTTP ${response.status}`).slice(0, 500))
    const retryable = response.status === 429 || response.status >= 500
    return failBatch(batch, error, retryable, retryAfterSeconds(response, batch.attempts))
  }

  if (!data?.id) {
    return failBatch(batch, new Error('OneSignal did not return a notification ID'))
  }

  const count = Number(data.recipients)
  const acceptedCount = Number.isInteger(count) && count >= 0 ? count : 0
  return markBatchSent(batch, job.id, data.id, acceptedCount)
}

export async function processStoryEpisodePushOnce() {
  if (process.env.STORY_EPISODE_PUSH_ENABLED !== 'true') {
    return { ok: true, skipped: 'disabled' }
  }

  const appId = String(process.env.ONESIGNAL_APP_ID || '').trim()
  const apiKey = String(process.env.ONESIGNAL_REST_API_KEY || '').trim()
  if (!appId || !apiKey) throw new Error('Missing OneSignal credentials')

  const preparation = requireResult(
    await supabase.rpc('prepare_story_episode_push_batch'),
    'prepare push batch'
  )
  if (preparation?.job_id && preparation.is_done) {
    await finishJob(preparation.job_id)
  }

  const batch = requireResult(
    await supabase.rpc('claim_story_episode_push_batch', { p_lease_seconds: 120 }),
    'claim push batch'
  )
  if (!batch) return { ok: true, prepared: Boolean(preparation), idle: !preparation }

  try {
    return await sendBatch(batch, appId, apiKey)
  } catch (error) {
    return failBatch(batch, error)
  }
}
