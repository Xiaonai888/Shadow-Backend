import { supabase } from '../config/supabase.js'
import { invalidateStudioChannelCache } from './shadowStudioChannelCache.service.js'
import { studioYoutubeId, probeStudioYoutubeIds } from './shadowStudioYoutubeProbe.service.js'

const RUN_INTERVAL_MS = 10 * 60 * 1000
const MAX_BATCH = 25
let timer = null
let running = false
let lastErrorAt = 0

function logError(error) {
  if (Date.now() - lastErrorAt < 60 * 60 * 1000) return
  lastErrorAt = Date.now()
  console.error('STUDIO_YOUTUBE_HEALTH_ERROR', error?.message || String(error))
}

export async function runStudioYoutubeHealthBatch() {
  if (running) return { skipped: true }
  running = true
  try {
    const { data: jobs, error: claimError } = await supabase.rpc('shadow_studio_claim_youtube_health', {
      p_limit: MAX_BATCH,
    })
    if (claimError) throw claimError
    if (!Array.isArray(jobs) || !jobs.length) return { checked: 0, changed: 0 }

    const ids = jobs.map(job => studioYoutubeId(job.video_url)).filter(Boolean)
    const statuses = await probeStudioYoutubeIds(ids)
    let changed = 0
    let unknown = 0
    const owners = new Set()

    for (const job of jobs) {
      const videoId = studioYoutubeId(job.video_url)
      const status = videoId ? statuses.get(videoId) || 'unknown' : 'missing'
      if (status === 'unknown') unknown++
      try {
        const { data, error } = await supabase.rpc('shadow_studio_apply_youtube_health', {
          p_video: job.video_id,
          p_lease_due_at: job.lease_due_at,
          p_result: status,
        })
        if (error) throw error
        if (data?.changed) {
          changed++
          if (data?.owner_id) owners.add(data.owner_id)
        }
      } catch (error) {
        logError(error)
      }
    }

    for (const owner of owners) {
      try {
        await invalidateStudioChannelCache(owner)
      } catch (error) {
        logError(error)
      }
    }

    return { checked: jobs.length, changed, unknown }
  } catch (error) {
    logError(error)
    return { checked: 0, error: error?.message || 'UNKNOWN' }
  } finally {
    running = false
  }
}

export function startStudioYoutubeHealthWorker() {
  if (timer || process.env.SHADOW_STUDIO_YOUTUBE_HEALTH_ENABLED !== 'true') return
  void runStudioYoutubeHealthBatch()
  timer = setInterval(() => { void runStudioYoutubeHealthBatch() }, RUN_INTERVAL_MS)
  timer.unref?.()
}

export function stopStudioYoutubeHealthWorker() {
  if (timer) clearInterval(timer)
  timer = null
}
