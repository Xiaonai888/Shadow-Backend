import {
  evaluateHeavyJobAdmission,
  getMemoryGuardSnapshot,
} from '../memoryGuard.service.js'
import { getResourcePolicy } from './resourcePolicies.js'

const GUARDED_JOB_TYPES = new Set(['manga_page_v2', 'story_image_pipeline'])

function nonnegative(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function admissionResponse({ policy, allowed, reason, memory, projectedMb, laneActive, guardAdmission }) {
  return {
    jobType: policy.jobType,
    lane: policy.lane,
    allowed,
    reason,
    action: allowed ? 'admit' : 'defer',
    memory: {
      usedMb: nonnegative(memory?.container_total_mb),
      limitMb: nonnegative(memory?.container_limit_mb),
      projectedMb: nonnegative(projectedMb),
      reserveMb: policy.safetyReserveMb,
      estimatedJobMb: policy.estimatedJobMb,
      blocked: Boolean(memory?.blocked),
      critical: Boolean(memory?.critical),
      emergency: Boolean(memory?.emergency),
      guardReason: typeof guardAdmission?.reason === 'string' ? guardAdmission.reason : null,
    },
    activeInLane: laneActive,
    laneLimit: policy.maxParallel,
  }
}

export function computeResourceAdmission({
  jobType,
  memorySnapshot,
  guardAdmission = null,
  activeJobs = [],
} = {}) {
  const policy = getResourcePolicy(jobType)
  const memory = memorySnapshot && typeof memorySnapshot === 'object'
    ? memorySnapshot
    : null
  const used = nonnegative(memory?.container_total_mb)
  const limit = nonnegative(memory?.container_limit_mb)
  const active = Array.isArray(activeJobs) ? activeJobs : []
  const laneActive = active.filter((job) =>
    job?.state === 'running' && job?.lane === policy.lane
  ).length
  const projected = used === null
    ? null
    : used + policy.estimatedJobMb + policy.safetyReserveMb

  const respond = (allowed, reason) => admissionResponse({
    policy,
    allowed,
    reason,
    memory,
    projectedMb: projected,
    laneActive,
    guardAdmission,
  })

  if (!policy.schedulable) return respond(false, 'UNREGISTERED_JOB')
  if (used === null || limit === null || limit <= 0) {
    return respond(false, 'MEMORY_METRICS_UNAVAILABLE')
  }
  if (memory.emergency) return respond(false, 'EMERGENCY_MEMORY')
  if (memory.critical) return respond(false, 'CRITICAL_MEMORY')

  if (GUARDED_JOB_TYPES.has(policy.jobType) && typeof guardAdmission?.allowed !== 'boolean') {
    return respond(false, 'EXISTING_MEMORY_GUARD_UNAVAILABLE')
  }
  if (guardAdmission?.allowed === false) {
    return respond(
      false,
      `EXISTING_MEMORY_GUARD_${String(guardAdmission.reason || 'DENIED').toUpperCase()}`
    )
  }
  if (memory.blocked) return respond(false, 'MEMORY_PROTECT_ACTIVE')
  if (laneActive >= policy.maxParallel) return respond(false, 'LANE_AT_CAPACITY')
  if (projected >= limit) return respond(false, 'PROJECTED_MEMORY_EXCEEDS_LIMIT')
  return respond(true, 'SAFE_TO_START')
}

export function evaluateResourceAdmission({ jobType, activeJobs = [] } = {}) {
  const memorySnapshot = getMemoryGuardSnapshot()
  const guardAdmission = GUARDED_JOB_TYPES.has(String(jobType))
    ? evaluateHeavyJobAdmission({ jobType })
    : null
  return computeResourceAdmission({
    jobType,
    memorySnapshot,
    guardAdmission,
    activeJobs,
  })
}
