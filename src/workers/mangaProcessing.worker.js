import dotenv from 'dotenv'
import {
  completeHeavyMediaJob,
  failHeavyMediaJob,
  getHeavyMediaJob,
} from '../services/heavyMediaJob.service.js'
import {
  deleteMangaTempObject,
  downloadMangaTempBuffer,
} from '../services/mangaTempStorage.service.js'

dotenv.config()

const MB = 1024 * 1024
const MANGA_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const SAMPLE_INTERVAL_MS = 2000

function cleanText(value, maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength)
}

function memoryMb(bytes) {
  return Number(
    (Number(bytes || 0) / MB).toFixed(1)
  )
}

function sendMessage(message) {
  if (typeof process.send !== 'function') return

  try {
    process.send(message)
  } catch {
  }
}

async function deleteTempSafely(key) {
  if (!key) return

  try {
    await deleteMangaTempObject(key)
  } catch (error) {
    console.error(
      'MANGA WORKER TEMP CLEANUP ERROR:',
      error
    )
  }
}

async function main() {
  const jobId = cleanText(process.argv[2], 80)
  const workerId = cleanText(process.argv[3], 160)

  if (!jobId || !workerId) {
    throw new Error(
      'Manga worker requires jobId and workerId.'
    )
  }

  let peakRss = process.memoryUsage().rss

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
    const job = await getHeavyMediaJob({ jobId })

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

    const tempObjectKey =
      cleanText(job.temp_object_key, 1000)
    const payload =
      job.payload &&
      typeof job.payload === 'object'
        ? job.payload
        : {}

    if (!tempObjectKey) {
      const error = new Error(
        'The manga job has no temporary storage key.'
      )
      error.code = 'MANGA_TEMP_KEY_MISSING'
      throw error
    }

    const sourceBytes =
      Number(payload.source_bytes || 0)
    const buffer = await downloadMangaTempBuffer(
      tempObjectKey,
      MANGA_IMAGE_MAX_BYTES
    )

    if (
      sourceBytes > 0 &&
      buffer.length !== sourceBytes
    ) {
      const error = new Error(
        'The staged manga image size did not match the uploaded size.'
      )
      error.code = 'IMAGE_UPLOAD_SIZE_MISMATCH'
      error.statusCode = 400
      throw error
    }

    const { default: sharp } = await import('sharp')
    sharp.concurrency(1)

    const {
      processMangaImage,
    } = await import(
      '../services/mangaImageProcessor.service.js'
    )
    const {
      uploadProcessedMangaParts,
    } = await import(
      '../services/mangaPageStorage.service.js'
    )

    const file = {
      buffer,
      size: buffer.length,
      mimetype:
        cleanText(payload.content_type, 120) ||
        'application/octet-stream',
      originalname:
        cleanText(payload.original_name, 240) ||
        'manga-page',
    }

    const processed = await processMangaImage(file)
    const stored = await uploadProcessedMangaParts({
      processed,
      folder:
        `episode-content/${job.user_id}/manga-v2`,
    })

    const parts = Array.isArray(stored.parts)
      ? stored.parts
      : []
    const firstPart = parts[0] || {}
    const totalBytes = parts.reduce(
      (sum, part) =>
        sum + Number(part.file_size || 0),
      0
    )

    const result = {
      image_url: firstPart.image_url || null,
      storage_path:
        firstPart.storage_path || null,
      source_format: stored.source_format || null,
      source_width:
        Number(stored.source_width || 0) || null,
      source_height:
        Number(stored.source_height || 0) || null,
      source_bytes:
        sourceBytes || buffer.length,
      width: Number(stored.width || 0) || null,
      height: Number(stored.height || 0) || null,
      file_size: totalBytes,
      mime_type: 'image/webp',
      part_count:
        Number(stored.part_count || parts.length),
      parts,
    }

    const completed = await completeHeavyMediaJob({
      jobId,
      workerId,
      result,
      finalObjectKey:
        firstPart.storage_path || null,
    })

    if (!completed) {
      const error = new Error(
        'The manga job could not be marked complete.'
      )
      error.code = 'MANGA_JOB_COMPLETE_SYNC_FAILED'
      throw error
    }

    await deleteTempSafely(tempObjectKey)

    peakRss = Math.max(
      peakRss,
      process.memoryUsage().rss
    )

    sendMessage({
      type: 'done',
      status: 'done',
      peak_rss_mb: memoryMb(peakRss),
    })
  } catch (error) {
    console.error(
      'MANGA BACKGROUND WORKER ERROR:',
      error
    )

    let failedJob = null

    try {
      failedJob = await failHeavyMediaJob({
        jobId,
        workerId,
        errorCode:
          cleanText(error?.code, 120) ||
          'MANGA_PROCESSING_FAILED',
        errorMessage:
          cleanText(error?.message, 1000) ||
          'Manga background processing failed.',
        retry: true,
        retryDelaySeconds: 30,
      })
    } catch (syncError) {
      console.error(
        'MANGA WORKER FAILURE SYNC ERROR:',
        syncError
      )
      throw error
    }

    if (failedJob?.status === 'failed') {
      await deleteTempSafely(
        failedJob.temp_object_key
      )
    }

    peakRss = Math.max(
      peakRss,
      process.memoryUsage().rss
    )

    sendMessage({
      type: 'failed',
      status: failedJob?.status || 'failed',
      peak_rss_mb: memoryMb(peakRss),
    })
  } finally {
    clearInterval(sampleTimer)
  }
}

main()
  .then(() => {
    process.exitCode = 0
  })
  .catch((error) => {
    console.error(
      'MANGA WORKER FATAL ERROR:',
      error
    )
    process.exitCode = 1
  })
