import { randomUUID } from 'node:crypto'
import { cleanupExpiredResourceCostReports, findStoredResourceCostReport, getStoredResourceCostReport, listStoredResourceCostReports, storedReportJob, openStoredResourceCostReport, deleteStoredResourceCostReport } from './resourceCostReportStorage.service.js'

const TTL_MS = 15 * 60 * 1000
const MAX_JOBS = 2
const jobs = new Map()
let activeId = null
let downloadActive = false
let deletionActive = false

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
    filename: null, size_bytes: null, error_code: job.errorCode ?? null,
    reason: job.reason ?? null, download_ready: false,
  }
}

function localJob(owner, id) {
  const job = jobs.get(id)
  if (job && job.owner === owner && (!job.expiresAt || job.expiresAt > Date.now())) return job
  return null
}

function removeJob(job) {
  if (['running', 'queued'].includes(job.status)) return false
  clearTimeout(job.timer)
  jobs.delete(job.id)
  return true
}

function expireLater(job) {
  job.expiresAt = Date.now() + TTL_MS
  job.timer = setTimeout(() => removeJob(job), TTL_MS)
  job.timer.unref?.()
}

function existingJob(owner, key) {
  for (const job of jobs.values()) {
    if (job.expiresAt && job.expiresAt <= Date.now()) removeJob(job)
    else if (job.owner === owner && job.key === key && ['queued', 'running'].includes(job.status)) return job
  }
  return null
}

export async function startResourceCostJob({ owner, key, format, run, admit = () => {}, client = null }) {
  if (!owner || typeof key !== 'string' || typeof run !== 'function') throw new TypeError('Invalid report job.')
  let existing = existingJob(owner, key)
  if (existing) return { job: publicJob(existing), reused: true }
  const saved = await findStoredResourceCostReport(owner, key, client)
  if (saved) return { job: storedReportJob(saved), reused: true }
  existing = existingJob(owner, key)
  if (existing) return { job: publicJob(existing), reused: true }
  if (activeId || downloadActive || deletionActive) throw busy('report_in_progress')
  if (jobs.size >= MAX_JOBS) {
    const disposable = [...jobs.values()].find(job => job.owner === owner && ['failed', 'deferred'].includes(job.status))
    if (disposable) removeJob(disposable)
  }
  if (jobs.size >= MAX_JOBS) throw busy('report_storage_full')
  admit()
  const stamp = new Date().toISOString()
  const job = { id: randomUUID(), owner, key, format, status: 'queued', stage: 'queued', progress: 0, createdAt: stamp, updatedAt: stamp, expiresAt: null }
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
      const saved = await run(update, job.id, () => cleanupExpiredResourceCostReports(client))
      if (saved?.id !== job.id || saved?.status !== 'ready') throw new Error('Report was not durably saved.')
      jobs.delete(job.id)
    } catch (error) {
      job.status = error?.code === 'RESOURCE_COST_BUSY' ? 'deferred' : 'failed'
      job.stage = job.status
      job.errorCode = job.status === 'deferred' ? 'RESOURCE_COST_BUSY' : 'RESOURCE_COST_JOB_FAILED'
      job.reason = job.status === 'deferred' ? String(error.reason || 'memory_pressure').slice(0, 80) : 'report_generation_failed'
      if (job.status === 'failed') console.error('RESOURCE_COST_JOB_ERROR:', error?.code || 'UNKNOWN')
      job.updatedAt = new Date().toISOString()
      expireLater(job)
    } finally {
      activeId = null
    }
  })()
  return { job: publicJob(job), reused: false }
}

export async function getResourceCostJob(owner, id, client = null) {
  const local = localJob(owner, id)
  if (local) return publicJob(local)
  return storedReportJob(await getStoredResourceCostReport(owner, id, client))
}

export async function listResourceCostJobs(owner, offset, limit, client = null) {
  return listStoredResourceCostReports(owner, offset, limit, client)
}

export async function acquireResourceCostJobDownload(owner, id, client = null) {
  const local = localJob(owner, id)
  if (local) throw jobError('RESOURCE_COST_JOB_NOT_READY', 'Report is not ready.')
  if (activeId || downloadActive || deletionActive) throw busy('report_in_progress')
  downloadActive = true
  try {
    const row = await getStoredResourceCostReport(owner, id, client)
    let released = false
    return { file: { filename: row.filename, size: row.size_bytes, contentType: row.content_type, open: canceled => openStoredResourceCostReport(row, { client, canceled }) }, release() {
      if (released) return
      released = true
      downloadActive = false
    } }
  } catch (error) {
    downloadActive = false
    throw error
  }
}

export async function deleteResourceCostJob(owner, id, client = null) {
  if (activeId || downloadActive || deletionActive) throw busy('report_in_progress')
  const local = localJob(owner, id)
  if (local) {
    if (!removeJob(local)) throw busy('report_in_progress')
    return { deleted: true }
  }
  deletionActive = true
  try { return await deleteStoredResourceCostReport(owner, id, client) }
  finally { deletionActive = false }
}
