import { randomUUID } from 'node:crypto'

const TTL_MS = 15 * 60 * 1000
const MAX_JOBS = 2
const jobs = new Map()
let activeId = null
let downloadActive = false

function jobError(code, message, reason) {
  return Object.assign(new Error(message), { code, reason })
}

function busy(reason) {
  return jobError('RESOURCE_COST_BUSY', 'Resource & Cost report is temporarily busy. Please retry shortly.', reason)
}

function publicJob(job) {
  return {
    id: job.id, status: job.status, stage: job.stage, progress: job.progress,
    format: job.format, created_at: job.createdAt, updated_at: job.updatedAt,
    expires_at: job.expiresAt ? new Date(job.expiresAt).toISOString() : null,
    filename: job.file?.filename ?? null, size_bytes: job.file?.size ?? null,
    error_code: job.errorCode ?? null, reason: job.reason ?? null,
    download_ready: job.status === 'ready',
  }
}

function ownedJob(owner, id) {
  const job = jobs.get(id)
  if (!job || job.owner !== owner || (job.expiresAt && job.expiresAt <= Date.now())) {
    throw jobError('RESOURCE_COST_JOB_NOT_FOUND', 'Report job not found or expired.')
  }
  return job
}

function removeJob(job) {
  if (job.reading || job.status === 'running' || job.status === 'queued') return false
  if (job.cleanupPending) return false
  if (!job.file) {
    clearTimeout(job.timer)
    jobs.delete(job.id)
    return true
  }
  clearTimeout(job.timer)
  job.cleanupPending = true
  Promise.resolve().then(() => job.file.cleanup()).then(() => {
    clearTimeout(job.timer)
    jobs.delete(job.id)
  }).catch(error => {
    job.cleanupPending = false
    console.error('RESOURCE_COST_JOB_CLEANUP_ERROR:', error?.code || 'UNKNOWN')
    job.timer = setTimeout(() => removeJob(job), 60_000)
    job.timer.unref?.()
  })
  return false
}

function expireLater(job) {
  job.expiresAt = Date.now() + TTL_MS
  job.timer = setTimeout(() => removeJob(job), TTL_MS)
  job.timer.unref?.()
}

export function startResourceCostJob({ owner, key, format, run, admit = () => {} }) {
  if (!owner || typeof key !== 'string' || typeof run !== 'function') throw new TypeError('Invalid report job.')
  for (const job of jobs.values()) {
    if (job.expiresAt && job.expiresAt <= Date.now()) removeJob(job)
    else if (job.owner === owner && job.key === key && ['queued', 'running', 'ready'].includes(job.status)) {
      return { job: publicJob(job), reused: true }
    }
  }
  if (activeId || downloadActive) throw busy('report_in_progress')
  if (jobs.size >= MAX_JOBS) {
    const disposable = [...jobs.values()].find(job => job.owner === owner && !job.reading && ['failed', 'deferred'].includes(job.status))
    if (disposable) removeJob(disposable)
  }
  if (jobs.size >= MAX_JOBS) throw busy('report_storage_full')
  admit()
  const stamp = new Date().toISOString()
  const job = { id: randomUUID(), owner, key, format, status: 'queued', stage: 'queued', progress: 0, createdAt: stamp, updatedAt: stamp, expiresAt: null, file: null }
  jobs.set(job.id, job)
  activeId = job.id
  const update = (stage, progress) => {
    if (job.status !== 'running') return
    job.stage = stage
    job.progress = Math.max(job.progress, Math.min(99, Math.floor(progress)))
    job.updatedAt = new Date().toISOString()
  }
  job.status = 'running'
  update('collecting_data', 0)
  void (async () => {
    try {
      job.file = await run(update)
      job.status = 'ready'
      job.stage = 'ready'
      job.progress = 100
    } catch (error) {
      job.status = error?.code === 'RESOURCE_COST_BUSY' ? 'deferred' : 'failed'
      job.stage = job.status
      job.errorCode = job.status === 'deferred' ? 'RESOURCE_COST_BUSY' : 'RESOURCE_COST_JOB_FAILED'
      job.reason = job.status === 'deferred' ? String(error.reason || 'memory_pressure').slice(0, 80) : 'report_generation_failed'
      if (job.status === 'failed') console.error('RESOURCE_COST_JOB_ERROR:', error?.code || 'UNKNOWN')
    } finally {
      job.updatedAt = new Date().toISOString()
      activeId = null
      expireLater(job)
    }
  })()
  return { job: publicJob(job), reused: false }
}

export function getResourceCostJob(owner, id) {
  return publicJob(ownedJob(owner, id))
}

export function acquireResourceCostJobDownload(owner, id) {
  const job = ownedJob(owner, id)
  if (job.status !== 'ready' || !job.file) throw jobError('RESOURCE_COST_JOB_NOT_READY', 'Report is not ready.')
  if (activeId || downloadActive) throw busy('report_in_progress')
  downloadActive = true
  job.reading = true
  let released = false
  return { file: job.file, release() {
    if (released) return
    released = true
    downloadActive = false
    job.reading = false
    if (job.expiresAt <= Date.now()) removeJob(job)
  } }
}

export function deleteResourceCostJob(owner, id) {
  const job = ownedJob(owner, id)
  if (job.reading || ['queued', 'running'].includes(job.status)) throw busy('report_in_progress')
  job.expiresAt = Date.now()
  removeJob(job)
  return { deleted: true }
}
