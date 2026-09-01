const MB = 1024 * 1024

const WARNING_RSS_BYTES = 300 * MB
const BLOCK_RSS_BYTES = 330 * MB
const RESUME_RSS_BYTES = 290 * MB
const CRITICAL_RSS_BYTES = 420 * MB
const RETRY_AFTER_SECONDS = 30
const MANGA_LOCK_TIMEOUT_MS = 15 * 60 * 1000
const MANGA_SLOT_POLL_MS = 1000

let memoryBlocked = false
let activeMangaUpload = false

function rssBytes() {
  return Number(process.memoryUsage().rss || 0)
}

function memoryMb(bytes) {
  return Number((Number(bytes || 0) / MB).toFixed(1))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function updateMemoryBlockState(rss) {
  if (memoryBlocked && rss < RESUME_RSS_BYTES) {
    memoryBlocked = false
    console.log(
      'MEMORY_GUARD_RESUME:',
      JSON.stringify({ rss_mb: memoryMb(rss) })
    )
  }

  if (!memoryBlocked && rss >= BLOCK_RSS_BYTES) {
    memoryBlocked = true
  }
}

function rejectMangaUpload(res, rss, reason) {
  res.set('Retry-After', String(RETRY_AFTER_SECONDS))

  console.warn(
    'MEMORY_GUARD_REJECT:',
    JSON.stringify({
      kind: 'manga',
      reason,
      rss_mb: memoryMb(rss),
      active_manga_upload: activeMangaUpload,
    })
  )

  return res.status(503).json({
    ok: false,
    code: 'MANGA_PROCESSING_BUSY',
    stage: 'admission',
    message:
      'The image processor is temporarily busy. Please retry shortly.',
    retry_after_seconds: RETRY_AFTER_SECONDS,
  })
}

export function getMemoryGuardSnapshot() {
  const rss = rssBytes()
  updateMemoryBlockState(rss)

  return {
    rss_bytes: rss,
    rss_mb: memoryMb(rss),
    warning: rss >= WARNING_RSS_BYTES,
    blocked: memoryBlocked,
    critical: rss >= CRITICAL_RSS_BYTES,
    active_manga_upload: activeMangaUpload,
  }
}

export function guardMangaTempUploadMemory(req, res, next) {
  const rss = rssBytes()
  updateMemoryBlockState(rss)

  if (rss >= CRITICAL_RSS_BYTES) {
    return rejectMangaUpload(res, rss, 'critical_memory')
  }

  if (rss >= WARNING_RSS_BYTES) {
    console.warn(
      'MEMORY_GUARD_WARNING:',
      JSON.stringify({
        kind: 'manga_temp_upload',
        rss_mb: memoryMb(rss),
        processing_blocked: memoryBlocked,
      })
    )
  }

  return next()
}

export async function acquireMangaProcessingSlot(
  timeoutMs = MANGA_LOCK_TIMEOUT_MS
) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const rss = rssBytes()
    updateMemoryBlockState(rss)

    if (
      rss < CRITICAL_RSS_BYTES &&
      !memoryBlocked &&
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
  error.retryAfterSeconds = RETRY_AFTER_SECONDS
  throw error
}

export function guardMangaUploadMemory(req, res, next) {
  const rss = rssBytes()
  updateMemoryBlockState(rss)

  if (rss >= CRITICAL_RSS_BYTES) {
    return rejectMangaUpload(res, rss, 'critical_memory')
  }

  if (memoryBlocked) {
    return rejectMangaUpload(res, rss, 'high_memory')
  }

  if (activeMangaUpload) {
    return rejectMangaUpload(res, rss, 'manga_upload_active')
  }

  if (rss >= WARNING_RSS_BYTES) {
    console.warn(
      'MEMORY_GUARD_WARNING:',
      JSON.stringify({
        kind: 'manga',
        rss_mb: memoryMb(rss),
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
      JSON.stringify({ kind: 'manga' })
    )
    release()
  }, MANGA_LOCK_TIMEOUT_MS)

  lockTimer.unref?.()
  res.once('finish', onFinish)
  res.once('close', onClose)

  next()
}
