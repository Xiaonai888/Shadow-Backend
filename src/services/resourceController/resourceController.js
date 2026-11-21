import { registerRuntimeInspectable, getRuntimeMemoryInspector } from '../runtimeMemoryInspector.service.js'
import { listResourcePolicies } from './resourcePolicies.js'
import { evaluateResourceAdmission } from './resourceAdmission.js'
import { planResourceWork } from './resourcePlanner.js'
import {
  getResourceTelemetrySnapshot,
  getResourceTelemetrySummary,
  recordResourceAdmissionDecision,
  recordResourceJobEvent,
} from './resourceTelemetry.js'

let unregisterInspectable = null

export function startResourceController() {
  if (unregisterInspectable) return false
  unregisterInspectable = registerRuntimeInspectable({
    name: 'Central Resource Controller',
    mode: 'advisory_on_demand',
    reader: getResourceTelemetrySummary,
  })
  return true
}

export function stopResourceControllerInspector() {
  if (!unregisterInspectable) return false
  unregisterInspectable()
  unregisterInspectable = null
  return true
}

export function inspectResourceJob(jobType) {
  const activeJobs = getResourceTelemetrySnapshot({ eventLimit: 0 }).running
  return evaluateResourceAdmission({ jobType, activeJobs })
}

export function selectResourceJob({ candidates, now = Date.now() } = {}) {
  const activeJobs = getResourceTelemetrySnapshot({ eventLimit: 0 }).running
  const plan = planResourceWork({ candidates, activeJobs, now })
  for (const item of plan.considered) {
    recordResourceAdmissionDecision({
      jobType: item.jobType,
      jobId: item.jobId,
      allowed: item.allowed,
      reason: item.reason,
      at: now,
    })
  }
  return plan
}

export function markResourceJobStarted({ jobType, jobId, at = Date.now() } = {}) {
  return recordResourceJobEvent({ jobType, jobId, event: 'started', at })
}

export function markResourceJobFinished({
  jobType,
  jobId,
  status = 'completed',
  reason = '',
  at = Date.now(),
} = {}) {
  const terminal = ['completed', 'failed', 'canceled', 'stopped'].includes(status)
    ? status : 'failed'
  return recordResourceJobEvent({ jobType, jobId, event: terminal, reason, at })
}

export function getResourceControllerSnapshot({ eventLimit = 40 } = {}) {
  const runtime = getRuntimeMemoryInspector()
  return {
    generatedAt: runtime.generated_at,
    controllerStarted: Boolean(unregisterInspectable),
    mode: 'advisory_until_integrated',
    runtime,
    telemetry: getResourceTelemetrySnapshot({ eventLimit }),
    policies: listResourcePolicies(),
  }
}
