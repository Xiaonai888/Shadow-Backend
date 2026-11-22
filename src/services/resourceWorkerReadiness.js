import { evaluateHeavyJobAdmission } from '../memoryGuard.service.js'
import { readResourceCgroupMemory } from './resourceCgroupMemory.js'
import { RESOURCE_MEMORY_CONFIG } from './resourceMemoryConfig.js'

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function decimal(value) {
  return Number(value.toFixed(1))
}

export function summarizeResourceWorkerReadiness({
  admission,
  cgroup = null,
  config = RESOURCE_MEMORY_CONFIG,
} = {}) {
  const usedMb = numberOrNull(admission?.container_total_mb)
  const limitMb = numberOrNull(admission?.container_limit_mb)
  const jobMb = numberOrNull(admission?.estimated_job_mb)
  const reserveMb = numberOrNull(admission?.safety_reserve_mb)
  const projectedMb = numberOrNull(admission?.projected_mb)
  const fullBudget = [usedMb, limitMb, jobMb, reserveMb].every((item) => item !== null)
  const maximumStartMb = fullBudget ? decimal(limitMb - jobMb - reserveMb) : null
  const requiredBudgetReliefMb = fullBudget
    ? decimal(Math.max(0, usedMb - maximumStartMb + 0.1))
    : null
  const resumeBelowMb = numberOrNull(config?.resumeBelowMb)
  const guardBlocked = admission?.blocked === true
  const requiredProtectReliefMb = guardBlocked && usedMb !== null && resumeBelowMb !== null
    ? decimal(Math.max(0, usedMb - resumeBelowMb + 0.1))
    : 0
  const minimumReliefMb = requiredBudgetReliefMb === null
    ? null
    : decimal(Math.max(requiredBudgetReliefMb, requiredProtectReliefMb))
  const allowed = admission?.allowed === true
  const reason = typeof admission?.reason === 'string' ? admission.reason : 'admission_unavailable'

  return {
    jobType: String(admission?.job_type || 'unknown'),
    allowed,
    action: allowed ? 'admit' : 'defer',
    reason,
    current: {
      usedMb,
      limitMb,
      projectedMb,
      estimatedJobMb: jobMb,
      safetyReserveMb: reserveMb,
      guardBlocked,
      critical: admission?.critical === true,
      emergency: admission?.emergency === true,
    },
    budget: {
      maximumStartMb,
      requiredBudgetReliefMb,
      resumeBelowMb: guardBlocked ? resumeBelowMb : null,
      requiredProtectReliefMb,
      minimumEstimatedReliefMb: minimumReliefMb,
      estimatesOnly: true,
    },
    cgroup: cgroup?.container || null,
    usesExistingMemoryGuard: true,
    changesAdmissionPolicy: false,
  }
}

export function inspectResourceWorkerReadiness({ jobType = 'manga_page_v2' } = {}) {
  const checkedAt = new Date().toISOString()
  try {
    const admission = evaluateHeavyJobAdmission({ jobType })
    const cgroup = readResourceCgroupMemory()
    return {
      checkedAt,
      available: true,
      ...summarizeResourceWorkerReadiness({ admission, cgroup }),
    }
  } catch (error) {
    return {
      checkedAt,
      available: false,
      jobType: String(jobType),
      allowed: false,
      action: 'defer',
      reason: 'RESOURCE_READINESS_UNAVAILABLE',
      errorType: String(error?.name || 'Error').slice(0,60),
      usesExistingMemoryGuard: true,
      changesAdmissionPolicy: false,
    }
  }
}
