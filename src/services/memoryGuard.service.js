import { readFileSync } from 'node:fs'

const MB = 1024 * 1024

const DEFAULT_CONTAINER_LIMIT_MB = 512
const WARNING_TOTAL_MB = 300
const PROTECT_TOTAL_MB = 350
const RESUME_TOTAL_MB = 280
const CRITICAL_TOTAL_MB = 420
const EMERGENCY_TOTAL_MB = 460
const SAFETY_RESERVE_MB = 64
const RETRY_AFTER_SECONDS = 30
const MANGA_LOCK_TIMEOUT_MS = 15 * 60 * 1000
const MANGA_SLOT_POLL_MS = 1000
const CGROUP_CACHE_MS = 500

const JOB_MEMORY_COST_MB = Object.freeze({
  manga_page_v2: 150,
  manga_page_v1: 140,
  default: 120,
})

let memoryBlocked = false
let activeMangaUpload = false
let cgroupCache = {
  sampledAt: 0,
  usageBytes: 0,
  limitBytes: 0,
  source: 'process',
}

function memoryMb(bytes) {
  return Number(
    (Number(bytes || 0) / MB).toFixed(1)
  )
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readFirstNumber(paths) {
  for (const path of paths) {
    try {
      const raw = readFileSync(path, 'utf8').trim()

      if (!raw || raw === 'max') continue

      const value = Number(raw)

      if (
        Number.isFinite(value) &&
        value > 0
      ) {
        return value
      }
    } catch {
    }
  }

  return 0
}

function configuredLimitBytes() {
  const configuredMb = Number(
    process.env.RENDER_MEMORY_LIMIT_MB ||
    process.env.CONTAINER_MEMORY_LIMIT_MB ||
    DEFAULT_CONTAINER_LIMIT_MB
  )

  if (
    Number.isFinite(configuredMb) &&
    configuredMb >= 128 &&
    configuredMb <= 16384
  ) {
    return configuredMb * MB
  }

  return DEFAULT_CONTAINER_LIMIT_MB * MB
}

function readContainerMemory() {
  const now = Date.now()

  if (
    cgroupCache.sampledAt &&
    now - cgroupCache.sampledAt < CGROUP_CACHE_MS
  ) {
    return cgroupCache
  }

  const usageBytes = readFirstNumber([
    '/sys/fs/cgroup/memory.current',
    '/sys/fs/cgroup/memory/memory.usage_in_bytes',
  ])

  const detectedLimitBytes = readFirstNumber([
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  ])

  const configuredBytes = configuredLimitBytes()
  const saneDetectedLimit =
    detectedLimitBytes >= 128 * MB &&
    detectedLimitBytes <= 16 * 1024 * MB
      ? detectedLimitBytes
      : 0

  cgroupCache = {
    sampledAt: now,
    usageBytes,
    limitBytes:
      saneDetectedLimit || configuredBytes,
    source:
      usageBytes > 0
        ? 'cgroup'
        : 'process',
  }

  return cgroupCache
}

function getTotalMemoryState() {
  const parentRssBytes =
    Number(process.memoryUsage().rss || 0)
  const cgroup = readContainerMemory()
  const totalBytes = Math.max(
    parentRssBytes,
    Number(cgroup.usageBytes || 0)
  )
  const limitBytes =
    Number(cgroup.limitBytes || 0) ||
    configuredLimitBytes()

  return {
    parentRssBytes,
    totalBytes,
    limitBytes,
    source: cgroup.source,
  }
}

function updateMemoryBlockState(totalBytes) {
  const totalMb = memoryMb(totalBytes)

  if (
    memoryBlocked &&
    totalMb < RESUME_TOTAL_MB
  ) {
    memoryBlocked = false

    console.log(
      'MEMORY_GUARD_RESUME:',
      JSON.stringify({
        container_total_mb: totalMb,
      })
    )
  }

  if (
    !memoryBlocked &&
    totalMb >= PROTECT_TOTAL_MB
  ) {
    memoryBlocked = true

    console.warn(
      'MEMORY_GUARD_PROTECT:',
      JSON.stringify({
        container_total_mb: totalMb,
      })
    )
  }
}

function jobCostMb(jobType) {
  const key = String(jobType || '').trim()

  return Number(
    JOB_MEMORY_COST_MB[key] ||
    JOB_MEMORY_COST_MB.default
  )
}

function rejectMangaUpload(
  res,
  snapshot,
  reason
) {
  res.set(
    'Retry-After',
    String(RETRY_AFTER_SECONDS)
  )

  console.warn(
    'MEMORY_GUARD_REJECT:',
    JSON.stringify({
      kind: 'manga',
      reason,
      parent_rss_mb: snapshot.rss_mb,
      container_total_mb:
        snapshot.container_total_mb,
      container_limit_mb:
        snapshot.container_limit_mb,
      active_manga_upload:
        activeMangaUpload,
    })
  )

  return res.status(503).json({
    ok: false,
    code: 'MANGA_PROCESSING_BUSY',
    stage: 'admission',
    message:
      'The image processor is temporarily busy. Please retry shortly.',
    retry_after_seconds:
      RETRY_AFTER_SECONDS,
  })
}

export function getMemoryGuardSnapshot() {
  const state = getTotalMemoryState()

  updateMemoryBlockState(state.totalBytes)

  const totalMb = memoryMb(state.totalBytes)
  const limitMb = memoryMb(state.limitBytes)
  const parentRssMb =
    memoryMb(state.parentRssBytes)

  return {
    rss_bytes: state.parentRssBytes,
    rss_mb: parentRssMb,
    container_total_bytes:
      state.totalBytes,
    container_total_mb: totalMb,
    container_limit_bytes:
      state.limitBytes,
    container_limit_mb: limitMb,
    container_source: state.source,
    available_mb:
      Math.max(
        0,
        Number(
          (
            (state.limitBytes - state.totalBytes) /
            MB
          ).toFixed(1)
        )
      ),
    usage_percent:
      state.limitBytes > 0
        ? Number(
            (
              (state.totalBytes /
                state.limitBytes) *
              100
            ).toFixed(1)
          )
        : null,
    warning:
      totalMb >= WARNING_TOTAL_MB,
    blocked: memoryBlocked,
    critical:
      totalMb >= CRITICAL_TOTAL_MB,
    emergency:
      totalMb >= EMERGENCY_TOTAL_MB,
    active_manga_upload:
      activeMangaUpload,
  }
}

export function evaluateHeavyJobAdmission({
  jobType = 'manga_page_v2',
  estimatedJobMb = null,
  safetyReserveMb = SAFETY_RESERVE_MB,
} = {}) {
  const snapshot = getMemoryGuardSnapshot()
  const costMb =
    Number.isFinite(Number(estimatedJobMb)) &&
    Number(estimatedJobMb) > 0
      ? Number(estimatedJobMb)
      : jobCostMb(jobType)
  const reserveMb =
    Number.isFinite(Number(safetyReserveMb)) &&
    Number(safetyReserveMb) >= 0
      ? Number(safetyReserveMb)
      : SAFETY_RESERVE_MB

  const projectedMb =
    snapshot.container_total_mb +
    costMb +
    reserveMb

  let allowed = true
  let reason = 'safe'

  if (snapshot.emergency) {
    allowed = false
    reason = 'emergency_memory'
  } else if (snapshot.critical) {
    allowed = false
    reason = 'critical_memory'
  } else if (snapshot.blocked) {
    allowed = false
    reason = 'protect_state'
  } else if (
    projectedMb >=
    snapshot.container_limit_mb
  ) {
    allowed = false
    reason = 'projected_memory_limit'
  }

  return {
    allowed,
    reason,
    job_type: jobType,
    estimated_job_mb: costMb,
    safety_reserve_mb: reserveMb,
    projected_mb:
      Number(projectedMb.toFixed(1)),
    ...snapshot,
  }
}

export function guardMangaTempUploadMemory(
  req,
  res,
  next
) {
  const snapshot = getMemoryGuardSnapshot()

  if (snapshot.emergency) {
    return rejectMangaUpload(
      res,
      snapshot,
      'emergency_memory'
    )
  }

  if (snapshot.critical) {
    return rejectMangaUpload(
      res,
      snapshot,
      'critical_memory'
    )
  }

  if (snapshot.warning) {
    console.warn(
      'MEMORY_GUARD_WARNING:',
      JSON.stringify({
        kind: 'manga_temp_upload',
        parent_rss_mb: snapshot.rss_mb,
        container_total_mb:
          snapshot.container_total_mb,
        processing_blocked:
          snapshot.blocked,
      })
    )
  }

  return next()
}

export async function acquireMangaProcessingSlot(
  timeoutMs = MANGA_LOCK_TIMEOUT_MS
) {
  const startedAt = Date.now()

  while (
    Date.now() - startedAt <
    timeoutMs
  ) {
    const admission =
      evaluateHeavyJobAdmission({
        jobType: 'manga_page_v2',
      })

    if (
      admission.allowed &&
      !activeMangaUpload
    ) {
      activeMangaUpload = true
      let released = false

      return () => {
        if (released) return
        released = true
        activeMangaUpload = false
      }
    }

    await sleep(MANGA_SLOT_POLL_MS)
  }

  const error = new Error(
    'The image processor is temporarily busy. Please retry shortly.'
  )
  error.code = 'MANGA_PROCESSING_BUSY'
  error.statusCode = 503
  error.stage = 'admission'
  error.retryAfterSeconds =
    RETRY_AFTER_SECONDS
  throw error
}

export function guardMangaUploadMemory(
  req,
  res,
  next
) {
  const admission =
    evaluateHeavyJobAdmission({
      jobType: 'manga_page_v1',
    })

  if (!admission.allowed) {
    return rejectMangaUpload(
      res,
      admission,
      admission.reason
    )
  }

  if (activeMangaUpload) {
    return rejectMangaUpload(
      res,
      admission,
      'manga_upload_active'
    )
  }

  if (admission.warning) {
    console.warn(
      'MEMORY_GUARD_WARNING:',
      JSON.stringify({
        kind: 'manga',
        parent_rss_mb:
          admission.rss_mb,
        container_total_mb:
          admission.container_total_mb,
        projected_mb:
          admission.projected_mb,
      })
    )
  }

  activeMangaUpload = true
  let released = false

  const release = () => {
    if (released) return
    released = true
    activeMangaUpload = false
    clearTimeout(lockTimer)
    res.off('finish', onFinish)
    res.off('close', onClose)
  }

  const onFinish = () => release()
  const onClose = () => {
    if (res.writableEnded) release()
  }

  const lockTimer = setTimeout(() => {
    console.warn(
      'MEMORY_GUARD_LOCK_TIMEOUT:',
      JSON.stringify({
        kind: 'manga',
      })
    )
    release()
  }, MANGA_LOCK_TIMEOUT_MS)

  lockTimer.unref?.()
  res.once('finish', onFinish)
  res.once('close', onClose)

  next()
}
