import { evaluateHeavyJobAdmission } from '../memoryGuard.service.js'
import { getRuntimeMemoryInspector } from '../runtimeMemoryInspector.service.js'

const SUPPORTED_GUARD_JOBS = new Set(['manga_page_v2', 'story_image_pipeline'])

function numeric(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number * 10) / 10 : null
}

function difference(value, amount) {
  return value === null || amount === null ? null : Math.round((value - amount) * 10) / 10
}

function memoryEvidence(runtime, admission) {
  const container = runtime?.container || {}
  const process = runtime?.process || {}
  const totalMb = numeric(container.total_mb)
  const limitMb = numeric(container.limit_mb)
  const projectedMb = numeric(admission?.projected_mb)
  const admissionAllowed = typeof admission?.allowed === 'boolean' ? admission.allowed : null
  const reserveMb = numeric(admission?.safety_reserve_mb)
  const estimatedJobMb = numeric(admission?.estimated_job_mb)
  const guard = runtime?.guard || {}
  return {
    containerUsedMb: totalMb,
    containerLimitMb: limitMb,
    containerAvailableMb: numeric(container.available_mb),
    containerSource: String(container.source || 'unknown'),
    projectedMb,
    headroomAfterProjectionMb: difference(limitMb, projectedMb),
    estimatedJobMb,
    safetyReserveMb: reserveMb,
    parentRssMb: numeric(process.rss_mb),
    parentHeapUsedMb: numeric(process.heap_used_mb),
    parentHeapTotalMb: numeric(process.heap_total_mb),
    parentExternalMb: numeric(process.external_mb),
    parentArrayBuffersMb: numeric(process.array_buffers_mb),
    parentNonHeapRssMb: numeric(process.non_heap_rss_estimate_mb),
    protectActive: guard.blocked === true,
    critical: guard.critical === true,
    emergency: guard.emergency === true,
    admissionAllowed,
    admissionReason: typeof admission?.reason === 'string' ? admission.reason : 'unavailable',
  }
}

export function readResourceRuntimeEvidence({ jobType = 'manga_page_v2' } = {}) {
  const checkedAt = new Date().toISOString()
  try {
    const runtime = getRuntimeMemoryInspector()
    const admission = SUPPORTED_GUARD_JOBS.has(String(jobType))
      ? evaluateHeavyJobAdmission({ jobType })
      : null
    const workerEntry = Array.isArray(runtime?.inspectables)
      ? runtime.inspectables.find((entry) => entry?.name === 'Heavy Media Worker')
      : null
    const worker = workerEntry ? {
      available: true,
      state: String(workerEntry.state || 'unknown'),
      enabled: workerEntry.enabled === true,
      coordinatorStarted: workerEntry.coordinator_started === true,
      cycleRunning: workerEntry.cycle_running === true,
      active: workerEntry.entries > 0,
      activeJobTag: String(workerEntry.active_job_id || '').slice(-12) || null,
      activeForMs: numeric(workerEntry.active_for_ms),
      nextIdleCheckSeconds: numeric(workerEntry.idle_check_seconds),
      retryCheckSeconds: numeric(workerEntry.retry_check_seconds),
    } : {
      available: false,
      state: 'unknown',
      enabled: null,
      coordinatorStarted: null,
      cycleRunning: null,
      active: null,
      activeJobTag: null,
      activeForMs: null,
      nextIdleCheckSeconds: null,
      retryCheckSeconds: null,
    }
    return {
      checkedAt,
      available: true,
      jobType: String(jobType),
      source: 'runtime_memory_inspector_and_existing_guard',
      uptimeSeconds: numeric(runtime?.uptime_seconds),
      eventLoopUtilizationPercent: numeric(runtime?.event_loop?.utilization_percent),
      memory: memoryEvidence(runtime, admission),
      worker,
    }
  } catch (error) {
    return {
      checkedAt,
      available: false,
      jobType: String(jobType),
      source: 'runtime_read_failed',
      errorCode: 'RESOURCE_RUNTIME_EVIDENCE_UNAVAILABLE',
      errorType: String(error?.name || 'Error').slice(0,60),
      memory: null,
      worker: null,
    }
  }
}
