import { evaluateHeavyJobAdmission } from './memoryGuard.service.js'
import { getRuntimeMemoryInspector } from './runtimeMemoryInspector.service.js'

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function jobAgeSeconds(createdAt) {
  const started = Date.parse(String(createdAt || ''))
  return Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : null
}

export function getMangaQueuedJobDiagnostic(job) {
  const status = String(job?.status || 'queued').toLowerCase()
  const queuedSeconds = jobAgeSeconds(job?.created_at)
  const attempts = Math.max(0, Number(job?.attempt_count || 0))
  const result = {
    stage: status === 'processing' ? 'worker' : 'worker_queue',
    code: 'MANGA_DIAGNOSTIC_UNAVAILABLE',
    message: 'Cannot inspect the worker state yet. The job status itself is still available.',
    is_confirmed_failure: false,
    job_status: status,
    queue_age_seconds: queuedSeconds,
    attempt_count: attempts,
    worker_state: 'unknown',
    admission_allowed: null,
    admission_reason: null,
    memory: null,
  }

  try {
    const inspection = getRuntimeMemoryInspector()
    const worker = Array.isArray(inspection?.inspectables)
      ? inspection.inspectables.find((item) => item.name === 'Heavy Media Worker')
      : null
    const admission = evaluateHeavyJobAdmission({ jobType: 'manga_page_v2' })
    const workerState = String(worker?.state || 'unknown')
    const activeJobId = String(worker?.active_job_id || '')
    const isThisJobActive = Boolean(activeJobId && activeJobId === String(job?.id || ''))

    result.worker_state = workerState
    result.admission_allowed = Boolean(admission.allowed)
    result.admission_reason = String(admission.reason || 'unknown')
    result.memory = {
      used_mb: numberOrNull(admission.container_total_mb),
      limit_mb: numberOrNull(admission.container_limit_mb),
      projected_mb: numberOrNull(admission.projected_mb),
      estimated_job_mb: numberOrNull(admission.estimated_job_mb),
      safety_reserve_mb: numberOrNull(admission.safety_reserve_mb),
    }

    if (status === 'processing') {
      if (isThisJobActive) {
        result.code = 'MANGA_WORKER_PROCESSING'
        result.message = 'Worker has claimed this image and is processing it. No failure has been reported.'
      } else {
        result.code = 'MANGA_PROCESSING_NOT_ACTIVE_HERE'
        result.message = 'Database marks this job as processing, but this Backend process does not report it as the active worker job. Check its lease and worker logs.'
      }
      return result
    }

    if (worker?.enabled === false || workerState === 'disabled') {
      result.code = 'MANGA_WORKER_DISABLED'
      result.message = 'Manga worker is disabled on the running Backend (HEAVY_MEDIA_WORKER_ENABLED).'
    } else if (worker && worker.coordinator_started === false) {
      result.code = 'MANGA_WORKER_NOT_STARTED'
      result.message = 'Manga worker coordinator has not started in this Backend process.'
    } else if (activeJobId && !isThisJobActive) {
      result.code = 'MANGA_WORKER_BUSY'
      result.message = 'Worker is busy with another image. This queued job must wait for that image.'
    } else if (!admission.allowed) {
      result.code = 'MANGA_MEMORY_GATE_WAIT'
      result.message = `Memory Guard currently prevents a new Manga worker from starting (reason: ${result.admission_reason}; used: ${result.memory.used_mb} MB; projected: ${result.memory.projected_mb} MB; limit: ${result.memory.limit_mb} MB). This is a current condition, not a confirmed job failure.`
    } else if (workerState === 'unknown') {
      result.code = 'MANGA_COORDINATOR_STATE_UNKNOWN'
      result.message = 'The runtime did not provide a Manga coordinator state. Check Backend startup logs.'
    } else if (queuedSeconds !== null && queuedSeconds >= 90 && attempts === 0) {
      result.code = 'MANGA_JOB_NOT_CLAIMED'
      result.message = `The image has remained queued for ${queuedSeconds}s with 0 worker attempts although Memory Guard currently allows new jobs. Check HEAVY_MEDIA_COORDINATOR_ERROR and the claim_next_heavy_media_job database RPC; this check cannot prove which one failed.`
    } else {
      result.code = 'MANGA_JOB_WAITING'
      result.message = 'The image is queued. Worker has not claimed it yet; there is no confirmed upload failure.'
    }
  } catch {
    result.code = 'MANGA_DIAGNOSTIC_READ_FAILED'
    result.message = 'Worker diagnostic snapshot could not be read. Check Backend diagnostic logs.'
  }

  return result
}
