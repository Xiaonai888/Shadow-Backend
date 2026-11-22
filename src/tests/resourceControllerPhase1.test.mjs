import test from 'node:test'
import assert from 'node:assert/strict'
import { computeResourceAdmission } from '../services/resourceController/resourceAdmission.js'
import {
  parseResourceCgroupMemoryStat,
  readResourceCgroupMemory,
} from '../services/resourceController/resourceCgroupMemory.js'
import { summarizeResourceWorkerReadiness } from '../services/resourceController/resourceWorkerReadiness.js'

const safeSnapshot = {
  container_total_mb: 250,
  container_limit_mb: 512,
  blocked: false,
  critical: false,
  emergency: false,
}

test('Manga admission stays blocked when the existing Memory Guard denies it', () => {
  const result = computeResourceAdmission({
    jobType: 'manga_page_v2',
    memorySnapshot: safeSnapshot,
    guardAdmission: { allowed: false, reason: 'protect_state' },
  })
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'EXISTING_MEMORY_GUARD_PROTECT_STATE')
})

test('A missing Manga Memory Guard decision fails closed', () => {
  const result = computeResourceAdmission({
    jobType: 'manga_page_v2',
    memorySnapshot: safeSnapshot,
  })
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'EXISTING_MEMORY_GUARD_UNAVAILABLE')
})

test('Manga cannot exceed its policy lane concurrency', () => {
  const result = computeResourceAdmission({
    jobType: 'manga_page_v2',
    memorySnapshot: safeSnapshot,
    guardAdmission: { allowed: true, reason: 'safe' },
    activeJobs: [{ state: 'running', lane: 'heavy_media' }],
  })
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'LANE_AT_CAPACITY')
})

test('Manga admission is safe with enough free RAM and an empty lane', () => {
  const result = computeResourceAdmission({
    jobType: 'manga_page_v2',
    memorySnapshot: safeSnapshot,
    guardAdmission: { allowed: true, reason: 'safe' },
  })
  assert.equal(result.allowed, true)
  assert.equal(result.action, 'admit')
})

test('Manga is blocked if its projected usage exceeds the container limit', () => {
  const result = computeResourceAdmission({
    jobType: 'manga_page_v2',
    memorySnapshot: { ...safeSnapshot, container_total_mb: 350 },
    guardAdmission: { allowed: true, reason: 'safe' },
  })
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'PROJECTED_MEMORY_EXCEEDS_LIMIT')
})

test('Cgroup memory parsing separates anonymous memory from file cache', () => {
  const values = parseResourceCgroupMemoryStat('anon 325058560\nfile 12582912\ninactive_file 5242880\nshmem 1048576\nslab 2097152\n')
  assert.equal(values.anon, 325058560)
  assert.equal(values.file, 12582912)
  assert.equal(values.inactive_file, 5242880)
})

test('Cgroup evidence remains informational and never changes Memory Guard', () => {
  const values = {
    '/sys/fs/cgroup/memory.current': '361024716',
    '/sys/fs/cgroup/memory.max': '536870912',
    '/sys/fs/cgroup/memory.stat': 'anon 325058560\nfile 12582912\ninactive_file 5242880\nshmem 1048576\n',
  }
  const evidence = readResourceCgroupMemory({
    reader: (path) => values[path],
    processUsage: {
      rss: 340787200,
      heapUsed: 125829120,
      heapTotal: 146800640,
      external: 10485760,
      arrayBuffers: 5242880,
    },
  })
  assert.equal(evidence.container.limitMb, 512)
  assert.equal(evidence.container.anonymousMb, 310)
  assert.equal(evidence.container.informationalReclaimableFileMb, 4)
  assert.equal(evidence.modifiesMemoryGuard, false)
})

test('Worker readiness explains why 332 MB is not enough for the current Manga budget', () => {
  const result = summarizeResourceWorkerReadiness({
    admission: {
      job_type: 'manga_page_v2',
      allowed: false,
      reason: 'protect_state',
      container_total_mb: 332,
      container_limit_mb: 512,
      estimated_job_mb: 150,
      safety_reserve_mb: 64,
      projected_mb: 546,
      blocked: true,
    },
  })
  assert.equal(result.allowed, false)
  assert.equal(result.budget.maximumStartMb, 298)
  assert.equal(result.budget.minimumEstimatedReliefMb, 52.1)
  assert.equal(result.changesAdmissionPolicy, false)
})
