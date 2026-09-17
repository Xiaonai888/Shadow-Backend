import { unlink } from 'node:fs/promises'
import dotenv from 'dotenv'
import {
  completeHeavyMediaJob,
  failHeavyMediaJob,
  getHeavyMediaJob,
} from '../services/heavyMediaJob.service.js'
import {
  deleteMangaTempObject,
  downloadMangaTempFile,
} from '../services/mangaTempStorage.service.js'

dotenv.config()

const MB = 1024 * 1024
const MANGA_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const SAMPLE_INTERVAL_MS = 2000
const WORKER_ROUTE = 'WORKER /manga-v2'

let usageJobId = ''

const usageTotals = {
  events: 0,
  errors: 0,
  supabase_calls: 0,
  r2_get_count: 0,
  r2_get_bytes: 0,
  r2_put_count: 0,
  r2_put_bytes: 0,
  r2_delete_count: 0,
}

function cleanText(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength)
}

function memoryMb(bytes) {
  return Number((Number(bytes || 0) / MB).toFixed(1))
}

function jsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null))
  } catch {
    return 0
  }
}

function positiveNumber(value) {
  return Math.max(0, Number(value) || 0)
}

function positiveInteger(value, fallback = 1) {
  const number = Math.floor(Number(value) || 0)
  return number > 0 ? number : fallback
}

function sendMessage(message) {
  if (typeof process.send !== 'function') return

  try {
    process.send(message)
  } catch {
  }
}

function updateUsageTotals({
  dependency,
  operationMethod,
  bytes,
  error,
  count,
}) {
  const safeCount = positiveInteger(count)
  const safeBytes = positiveNumber(bytes)
  const dep = cleanText(dependency, 80).toUpperCase()
  const method = cleanText(operationMethod, 20).toUpperCase()

  usageTotals.events += safeCount
  usageTotals.errors += error ? safeCount : 0

  if (dep === 'SUPABASE') {
    usageTotals.supabase_calls += safeCount
  }

  if (dep === 'CLOUDFLARE_R2' && method === 'GET') {
    usageTotals.r2_get_count += safeCount
    usageTotals.r2_get_bytes += safeBytes
  }

  if (dep === 'CLOUDFLARE_R2' && method === 'PUT') {
    usageTotals.r2_put_count += safeCount
    usageTotals.r2_put_bytes += safeBytes
  }

  if (dep === 'CLOUDFLARE_R2' && method === 'DELETE') {
    usageTotals.r2_delete_count += safeCount
  }
}

function sendUsage({
  dependency,
  operationMethod,
  targetPath,
  bytes = 0,
  error = false,
  durationMs = 0,
  count = 1,
  direction = 'outbound',
  action = 'external',
}) {
  const safeDependency =
    cleanText(dependency, 80).toUpperCase() || 'UNKNOWN'
  const safeMethod =
    cleanText(operationMethod, 20).toUpperCase() || 'CALL'
  const safeTarget =
    cleanText(targetPath, 300) || '/worker/unknown'
  const safeBytes = positiveNumber(bytes)
  const safeCount = positiveInteger(count)

  updateUsageTotals({
    dependency: safeDependency,
    operationMethod: safeMethod,
    bytes: safeBytes,
    error: Boolean(error),
    count: safeCount,
  })

  sendMessage({
    type: 'system_usage',
    usage: {
      kind: 'external_request',
      key: `${WORKER_ROUTE} -> ${safeDependency} ${safeMethod} ${safeTarget}`,
      bytes: safeBytes,
      error: Boolean(error),
      duration_ms: positiveNumber(durationMs),
      count: safeCount,
      direction: cleanText(direction, 40) || 'outbound',
      cause: 'BACKGROUND',
      feature: 'manga_v2_worker',
      job_id: usageJobId || null,
      action: cleanText(action, 120) || 'external',
    },
  })
}

async function measureUsage(
  {
    dependency,
    operationMethod,
    targetPath,
    bytes = 0,
    bytesFromResult = null,
    count = 1,
    countFromResult = null,
    direction = 'outbound',
    action = 'external',
  },
  work
) {
  const startedAt = Date.now()

  try {
    const result = await work()
    const measuredBytes =
      typeof bytesFromResult === 'function'
        ? positiveNumber(bytesFromResult(result))
        : positiveNumber(bytes)
    const measuredCount =
      typeof countFromResult === 'function'
        ? positiveInteger(countFromResult(result), positiveInteger(count))
        : positiveInteger(count)

    sendUsage({
      dependency,
      operationMethod,
      targetPath,
      bytes: measuredBytes,
      error: false,
      durationMs: Date.now() - startedAt,
      count: measuredCount,
      direction,
      action,
    })

    return result
  } catch (error) {
    sendUsage({
      dependency,
      operationMethod,
      targetPath,
      bytes: positiveNumber(bytes),
      error: true,
      durationMs: Date.now() - startedAt,
      count: positiveInteger(count),
      direction,
      action,
    })

    throw error
  }
}

async function deleteTempSafely(key) {
  if (!key) return false

  try {
    await measureUsage(
      {
        dependency: 'CLOUDFLARE_R2',
        operationMethod: 'DELETE',
        targetPath: '/manga-v2/temp-source',
        direction: 'outbound',
        action: 'temp_cleanup',
      },
      () => deleteMangaTempObject(key)
    )
    return true
  } catch (error) {
    console.error('MANGA WORKER TEMP CLEANUP ERROR:', error)
    return false
  }
}

function usageSummary() {
  return {
    ...usageTotals,
    r2_get_mb: Number((usageTotals.r2_get_bytes / MB).toFixed(4)),
    r2_put_mb: Number((usageTotals.r2_put_bytes / MB).toFixed(4)),
  }
}

async function main() {
  const jobId = cleanText(process.argv[2], 80)
  const workerId = cleanText(process.argv[3], 160)

  if (!jobId || !workerId) {
    throw new Error('Manga worker requires jobId and workerId.')
  }

  usageJobId = jobId

  let peakRss = process.memoryUsage().rss
  let tempObjectKey = ''
  let sourceFilePath = ''
  let storedParts = []
  let completionPersisted = false
  let deleteStoredMangaParts = null
  let sourceTransferredBytes = 0
  let outputTransferredBytes = 0

  const sampleTimer = setInterval(() => {
    const rss = process.memoryUsage().rss
    peakRss = Math.max(peakRss, rss)

    sendMessage({
      type: 'memory',
      rss_mb: memoryMb(rss),
      peak_rss_mb: memoryMb(peakRss),
    })
  }, SAMPLE_INTERVAL_MS)

  sampleTimer.unref?.()

  try {
    const job = await measureUsage(
      {
        dependency: 'SUPABASE',
        operationMethod: 'CALL',
        targetPath: '/heavy-media-jobs/get',
        bytes: jsonBytes({ job_id: jobId }),
        direction: 'outbound',
        action: 'job_lookup',
      },
      () => getHeavyMediaJob({ jobId })
    )

    if (
      !job ||
      job.status !== 'processing' ||
      job.worker_id !== workerId ||
      job.job_type !== 'manga_page_v2'
    ) {
      const error = new Error(
        'The claimed manga job is not available to this worker.'
      )
      error.code = 'MANGA_JOB_NOT_AVAILABLE'
      throw error
    }

    tempObjectKey = cleanText(job.temp_object_key, 1000)
    const payload =
      job.payload && typeof job.payload === 'object'
        ? job.payload
        : {}

    if (!tempObjectKey) {
      const error = new Error('The manga job has no temporary storage key.')
      error.code = 'MANGA_TEMP_KEY_MISSING'
      throw error
    }

    const sourceBytes = Number(payload.source_bytes || 0)

    const sourceFile = await measureUsage(
      {
        dependency: 'CLOUDFLARE_R2',
        operationMethod: 'GET',
        targetPath: '/manga-v2/temp-source',
        bytesFromResult: (result) => Number(result?.size || 0),
        direction: 'inbound',
        action: 'source_download',
      },
      () =>
        downloadMangaTempFile(
          tempObjectKey,
          MANGA_IMAGE_MAX_BYTES
        )
    )

    sourceFilePath = sourceFile.path
    sourceTransferredBytes = Number(sourceFile.size || 0)

    if (sourceBytes > 0 && sourceFile.size !== sourceBytes) {
      const error = new Error(
        'The staged manga image size did not match the uploaded size.'
      )
      error.code = 'IMAGE_UPLOAD_SIZE_MISMATCH'
      error.statusCode = 400
      throw error
    }

    const { default: sharp } = await import('sharp')
    sharp.concurrency(1)
    sharp.cache(false)

    const { processMangaImage } = await import(
      '../services/mangaImageProcessor.service.js'
    )
    const mangaStorage = await import(
      '../services/mangaPageStorage.service.js'
    )
    const { uploadProcessedMangaPart } = mangaStorage
    deleteStoredMangaParts = mangaStorage.deleteStoredMangaParts
    const folder = `episode-content/${job.user_id}/manga-v2`

    const processed = await processMangaImage(
      {
        path: sourceFile.path,
        size: sourceFile.size,
        mimetype:
          cleanText(payload.content_type, 120) ||
          'application/octet-stream',
        originalname:
          cleanText(payload.original_name, 240) ||
          'manga-page',
      },
      {
        onPart: async (part) => {
          const partBytes = Number(
            part?.size ||
            part?.fileSize ||
            part?.buffer?.length ||
            0
          )

          const stored = await measureUsage(
            {
              dependency: 'CLOUDFLARE_R2',
              operationMethod: 'PUT',
              targetPath: '/manga-v2/processed-part',
              bytes: partBytes,
              bytesFromResult: (result) =>
                Number(result?.file_size || partBytes),
              direction: 'outbound',
              action: 'processed_part_upload',
            },
            () =>
              uploadProcessedMangaPart({
                part,
                folder,
              })
          )

          outputTransferredBytes += Number(
            stored?.file_size || partBytes || 0
          )
          storedParts.push(stored)
          return stored
        },
      }
    )

    const parts = Array.isArray(processed.parts)
      ? processed.parts
      : storedParts
    const firstPart = parts[0] || {}
    const totalBytes = parts.reduce(
      (sum, part) => sum + Number(part.file_size || 0),
      0
    )

    const result = {
      image_url: firstPart.image_url || null,
      storage_path: firstPart.storage_path || null,
      source_format: processed.sourceFormat || null,
      source_width: Number(processed.sourceWidth || 0) || null,
      source_height: Number(processed.sourceHeight || 0) || null,
      source_bytes: sourceBytes || sourceFile.size,
      width: Number(processed.width || 0) || null,
      height: Number(processed.height || 0) || null,
      file_size: totalBytes,
      mime_type: 'image/webp',
      part_count: Number(processed.partCount || parts.length),
      parts,
    }

    const completed = await measureUsage(
      {
        dependency: 'SUPABASE',
        operationMethod: 'CALL',
        targetPath: '/heavy-media-jobs/complete',
        bytes: jsonBytes({
          job_id: jobId,
          worker_id: workerId,
          result,
          final_object_key: firstPart.storage_path || null,
        }),
        direction: 'outbound',
        action: 'job_complete',
      },
      () =>
        completeHeavyMediaJob({
          jobId,
          workerId,
          result,
          finalObjectKey: firstPart.storage_path || null,
        })
    )

    if (!completed) {
      const error = new Error(
        'The manga job could not be marked complete.'
      )
      error.code = 'MANGA_JOB_COMPLETE_SYNC_FAILED'
      throw error
    }

    completionPersisted = true
    storedParts = []
    await deleteTempSafely(tempObjectKey)

    peakRss = Math.max(peakRss, process.memoryUsage().rss)

    sendMessage({
      type: 'done',
      status: 'done',
      peak_rss_mb: memoryMb(peakRss),
      source_bytes: sourceTransferredBytes,
      output_bytes: outputTransferredBytes || totalBytes,
      part_count: Number(result.part_count || 0),
      usage: usageSummary(),
    })
  } catch (error) {
    console.error('MANGA BACKGROUND WORKER ERROR:', error)

    if (storedParts.length > 0 && !completionPersisted) {
      try {
        const latestJob = await measureUsage(
          {
            dependency: 'SUPABASE',
            operationMethod: 'CALL',
            targetPath: '/heavy-media-jobs/get',
            bytes: jsonBytes({ job_id: jobId }),
            direction: 'outbound',
            action: 'job_recheck',
          },
          () => getHeavyMediaJob({ jobId })
        )

        if (latestJob?.status === 'done') {
          completionPersisted = true
          storedParts = []
          await deleteTempSafely(tempObjectKey)
          peakRss = Math.max(peakRss, process.memoryUsage().rss)

          sendMessage({
            type: 'done',
            status: 'done',
            peak_rss_mb: memoryMb(peakRss),
            source_bytes: sourceTransferredBytes,
            output_bytes: outputTransferredBytes,
            usage: usageSummary(),
          })
          return
        }

        if (typeof deleteStoredMangaParts === 'function') {
          const rollbackParts = [...storedParts]

          await measureUsage(
            {
              dependency: 'CLOUDFLARE_R2',
              operationMethod: 'DELETE',
              targetPath: '/manga-v2/rollback-parts',
              count: rollbackParts.length || 1,
              countFromResult: (result) =>
                Number(result?.requested || rollbackParts.length || 1),
              direction: 'outbound',
              action: 'rollback_cleanup',
            },
            () => deleteStoredMangaParts(rollbackParts)
          )

          storedParts = []
        }
      } catch (cleanupError) {
        console.error(
          'MANGA WORKER OUTPUT CLEANUP ERROR:',
          cleanupError
        )
      }
    }

    let failedJob = null
    const failurePayload = {
      job_id: jobId,
      worker_id: workerId,
      error_code:
        cleanText(error?.code, 120) ||
        'MANGA_PROCESSING_FAILED',
      error_message:
        cleanText(error?.message, 1000) ||
        'Manga background processing failed.',
    }

    try {
      failedJob = await measureUsage(
        {
          dependency: 'SUPABASE',
          operationMethod: 'CALL',
          targetPath: '/heavy-media-jobs/fail',
          bytes: jsonBytes(failurePayload),
          direction: 'outbound',
          action: 'job_fail',
        },
        () =>
          failHeavyMediaJob({
            jobId,
            workerId,
            errorCode: failurePayload.error_code,
            errorMessage: failurePayload.error_message,
            retry: false,
            retryDelaySeconds: 0,
          })
      )
    } catch (syncError) {
      console.error('MANGA WORKER FAILURE SYNC ERROR:', syncError)
      throw error
    }

    if (failedJob?.status === 'failed') {
      await deleteTempSafely(failedJob.temp_object_key)
    }

    peakRss = Math.max(peakRss, process.memoryUsage().rss)

    sendMessage({
      type: 'failed',
      status: failedJob?.status || 'failed',
      peak_rss_mb: memoryMb(peakRss),
      source_bytes: sourceTransferredBytes,
      output_bytes: outputTransferredBytes,
      usage: usageSummary(),
    })
  } finally {
    clearInterval(sampleTimer)

    if (sourceFilePath) {
      await unlink(sourceFilePath).catch(() => {})
    }
  }
}

main()
  .then(() => {
    process.exitCode = 0
  })
  .catch((error) => {
    console.error('MANGA WORKER FATAL ERROR:', error)
    process.exitCode = 1
  })
