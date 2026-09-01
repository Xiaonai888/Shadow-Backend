import { randomUUID } from 'node:crypto'
import { createHeavyMediaJob } from '../services/heavyMediaJob.service.js'
import {
  deleteMangaTempObject,
  uploadMangaTempStream,
} from '../services/mangaTempStorage.service.js'

const MANGA_IMAGE_MAX_BYTES = 5 * 1024 * 1024

function cleanHeader(value, maxLength = 300) {
  return String(value || '').trim().slice(0, maxLength)
}

function sendReceiveError(res, status, code, message, details = {}) {
  return res.status(status).json({
    ok: false,
    code,
    stage: 'receive',
    message,
    ...details,
  })
}

async function cleanupTempObject(key) {
  try {
    await deleteMangaTempObject(key)
  } catch (error) {
    console.error(
      'MANGA TEMP UPLOAD CLEANUP ERROR:',
      error
    )
  }
}

export async function stageMangaV2UploadToR2(req, res, next) {
  const userId = String(req.user?.user_id || '').trim()

  if (!userId) {
    return res.status(401).json({
      ok: false,
      code: 'UNAUTHORIZED',
      stage: 'auth',
      message: 'Please sign in again before uploading an image.',
    })
  }

  const contentLengthHeader = String(
    req.headers['content-length'] || ''
  ).trim()
  const expectedBytes = Number(contentLengthHeader)

  if (
    !contentLengthHeader ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0
  ) {
    res.set('Retry-After', '1')
    return sendReceiveError(
      res,
      411,
      'MANGA_UPLOAD_LENGTH_REQUIRED',
      'The manga image size could not be verified. Please choose the image again and retry.'
    )
  }

  if (expectedBytes > MANGA_IMAGE_MAX_BYTES) {
    return sendReceiveError(
      res,
      413,
      'MANGA_PAGE_TOO_LARGE',
      'Manga page must be 5 MB or smaller.',
      {
        expected_bytes: expectedBytes,
        max_bytes: MANGA_IMAGE_MAX_BYTES,
      }
    )
  }

  const uploadId = randomUUID()
  const tempObjectKey =
    `temp-processing/manga-v2/${userId}/${uploadId}/original`
  const contentType = cleanHeader(
    req.headers['content-type'],
    120
  )
    .split(';')[0]
    .trim()
    .toLowerCase() || 'application/octet-stream'
  const originalName =
    cleanHeader(req.headers['x-file-name'], 240) ||
    'manga-page'

  let tempUploaded = false

  try {
    await uploadMangaTempStream({
      key: tempObjectKey,
      body: req,
      contentType,
      contentLength: expectedBytes,
    })
    tempUploaded = true

    const job = await createHeavyMediaJob({
      userId,
      jobType: 'manga_page_v2',
      tempObjectKey,
      idempotencyKey: uploadId,
      priority: 100,
      maxAttempts: 3,
      payload: {
        upload_id: uploadId,
        source_bytes: expectedBytes,
        content_type: contentType,
        original_name: originalName,
        intake: 'r2_temp_stream',
      },
    })

    req.mangaTempUpload = {
      uploadId,
      jobId: job.id,
      tempObjectKey,
      size: expectedBytes,
      mimetype: contentType,
      originalname: originalName,
    }

    return next()
  } catch (error) {
    if (tempUploaded) {
      await cleanupTempObject(tempObjectKey)
    }

    console.error('MANGA TEMP UPLOAD ERROR:', error)

    const isConfigError =
      error?.code === 'R2_CONFIGURATION_ERROR' ||
      String(error?.message || '').includes('Missing R2_')

    if (!isConfigError) {
      res.set('Retry-After', '30')
    }

    return res.status(isConfigError ? 500 : 503).json({
      ok: false,
      code: isConfigError
        ? 'R2_CONFIGURATION_ERROR'
        : 'MANGA_TEMP_UPLOAD_FAILED',
      stage: 'storage',
      message: isConfigError
        ? 'Temporary image storage is not configured correctly.'
        : 'The manga image could not be saved for processing. Please retry shortly.',
      retry_after_seconds: isConfigError ? undefined : 30,
    })
  }
}
