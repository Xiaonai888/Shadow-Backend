import { getResourcePolicy } from './resourcePolicies.js'
import { evaluateResourceAdmission } from './resourceAdmission.js'

const MAX_CANDIDATES = 100
const AGE_BOOST_INTERVAL_MS = 60000
const MAX_AGE_BOOST = 16

function timestamp(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

function candidateType(candidate) {
  return String(candidate?.jobType || candidate?.job_type || '').trim()
}

function candidateId(candidate) {
  return String(candidate?.id || candidate?.jobId || '').trim()
}

export function rankResourceCandidates(candidates, { now = Date.now() } = {}) {
  const list = Array.isArray(candidates) ? candidates.slice(0, MAX_CANDIDATES) : []
  return list
    .map((candidate, index) => {
      const jobType = candidateType(candidate)
      const policy = getResourcePolicy(jobType)
      const status = String(candidate?.status || 'queued').toLowerCase()
      const createdAt = timestamp(candidate?.created_at ?? candidate?.createdAt, now)
      const ageMs = Math.max(0, now - createdAt)
      const boost = Math.min(MAX_AGE_BOOST, Math.floor(ageMs / AGE_BOOST_INTERVAL_MS))
      return {
        jobId: candidateId(candidate),
        jobType,
        status,
        lane: policy.lane,
        priority: policy.priority,
        score: policy.priority + boost,
        createdAt,
        ageMs,
        eligible: status === 'queued' && policy.schedulable,
        index,
      }
    })
    .filter((candidate) => candidate.jobId && candidate.eligible)
    .sort((a, b) => b.score - a.score || a.createdAt - b.createdAt || a.index - b.index)
}

export function planResourceWork({ candidates, activeJobs = [], now = Date.now() } = {}) {
  const ranked = rankResourceCandidates(candidates, { now })
  const considered = []
  for (const item of ranked) {
    const admission = evaluateResourceAdmission({ jobType: item.jobType, activeJobs })
    considered.push({
      jobId: item.jobId,
      jobType: item.jobType,
      score: item.score,
      ageMs: item.ageMs,
      allowed: admission.allowed,
      reason: admission.reason,
      memory: admission.memory,
    })
    if (admission.allowed) {
      return {
        selected: { jobId: item.jobId, jobType: item.jobType, lane: item.lane },
        considered,
        queuedCandidates: ranked.length,
        decision: 'admit',
      }
    }
  }
  return {
    selected: null,
    considered,
    queuedCandidates: ranked.length,
    decision: ranked.length ? 'defer' : 'empty',
  }
}
