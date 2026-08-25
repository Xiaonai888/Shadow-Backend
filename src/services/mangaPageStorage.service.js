import { wakeMangaR2DeleteRetryWorker } from './mangaR2DeleteRetry.service.js'
import { supabase } from '../config/supabase.js'
import {
  deleteR2ObjectByUrl,
  uploadFileToR2,
} from './r2Storage.service.js'

const DELETE_RETRY_DELAY_MS = 60 * 1000

function getStoragePath(imageUrl) {
  const publicBaseUrl = String(process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '')
  const value = String(imageUrl || '').trim()

  if (publicBaseUrl && value.startsWith(`${publicBaseUrl}/`)) {
    return value.slice(publicBaseUrl.length + 1)
  }

  return value
}

function normalizePart(part, index) {
  const partIndex = Number.isFinite(Number(part?.partIndex))
    ? Math.max(0, Math.floor(Number(part.partIndex)))
    : index

  return {
    partIndex,
    buffer: Buffer.isBuffer(part?.buffer) ? part.buffer : Buffer.alloc(0),
    width: Number(part?.width || 0),
    height: Number(part?.height || 0),
    fileSize: Number(part?.fileSize || part?.buffer?.length || 0),
    mimeType: String(part?.mimeType || 'image/webp'),
    quality: Number(part?.quality || 0) || null,
  }
}

function buildPartFile(part) {
  return {
    buffer: part.buffer,
    size: part.buffer.length,
    mimetype: 'image/webp',
    originalname: `part-${String(part.partIndex).padStart(3, '0')}.webp`,
  }
}

function cleanDeleteError(error) {
  return String(
    error?.message ||
    error?.code ||
    'R2_DELETE_FAILED'
  )
    .trim()
    .slice(0, 1000)
}

async function queueMangaR2DeleteRetry(imageUrl, error) {
  const url = String(imageUrl || '').trim()
  if (!url) return false

  const now = new Date()
  const nextRetryAt = new Date(
    now.getTime() + DELETE_RETRY_DELAY_MS
  ).toISOString()
  const lastError = cleanDeleteError(error)

  try {
    const { data: existing, error: lookupError } = await supabase
      .from('manga_r2_delete_retry_queue')
      .select('id')
      .eq('image_url', url)
      .maybeSingle()

    if (lookupError) throw lookupError

    if (existing?.id) {
      const { error: updateError } = await supabase
        .from('manga_r2_delete_retry_queue')
        .update({
          last_error: lastError,
          last_attempt_at: now.toISOString(),
          next_retry_at: nextRetryAt,
          updated_at: now.toISOString(),
        })
        .eq('id', existing.id)

      if (updateError) throw updateError
      return true
    }

    const { error: insertError } = await supabase
      .from('manga_r2_delete_retry_queue')
      .insert({
        image_url: url,
        attempts: 0,
        last_error: lastError,
        last_attempt_at: now.toISOString(),
        next_retry_at: nextRetryAt,
        updated_at: now.toISOString(),
      })

    if (!insertError) return true

    if (String(insertError.code || '') === '23505') {
      const { error: raceUpdateError } = await supabase
        .from('manga_r2_delete_retry_queue')
        .update({
          last_error: lastError,
          last_attempt_at: now.toISOString(),
          next_retry_at: nextRetryAt,
          updated_at: now.toISOString(),
        })
        .eq('image_url', url)

      if (raceUpdateError) throw raceUpdateError
      return true
    }

    throw insertError
  } catch (queueError) {
    console.error(
      'MANGA R2 DELETE RETRY QUEUE ERROR:',
      queueError
    )
    return false
  }
}

async function clearMangaR2DeleteRetry(imageUrl) {
  const url = String(imageUrl || '').trim()
  if (!url) return false

  try {
    const { error } = await supabase
      .from('manga_r2_delete_retry_queue')
      .delete()
      .eq('image_url', url)

    if (error) throw error
    return true
  } catch (queueError) {
    console.error(
      'MANGA R2 DELETE RETRY CLEAR ERROR:',
      queueError
    )
    return false
  }
}

export async function deleteStoredMangaParts(parts = []) {
  const urls = [
    ...new Set(
      (Array.isArray(parts) ? parts : [])
        .map((part) => part?.image_url || part?.imageUrl)
        .map((url) => String(url || '').trim())
        .filter(Boolean)
    ),
  ]

  const results = await Promise.allSettled(
    urls.map((url) => deleteR2ObjectByUrl(url))
  )

  const deletedUrls = []
  const failedDeletes = []
  let ignored = 0

  results.forEach((result, index) => {
    const url = urls[index]

    if (
      result.status === 'fulfilled' &&
      result.value === true
    ) {
      deletedUrls.push(url)
      return
    }

    if (result.status === 'rejected') {
      failedDeletes.push({
        url,
        error: result.reason,
      })
      return
    }

    ignored += 1
  })

  await Promise.allSettled(
    deletedUrls.map((url) =>
      clearMangaR2DeleteRetry(url)
    )
  )

  const queueResults = await Promise.allSettled(
    failedDeletes.map(({ url, error }) =>
      queueMangaR2DeleteRetry(url, error)
    )
  )

  const queued = queueResults.filter(
    (result) =>
      result.status === 'fulfilled' &&
      result.value === true
  ).length

  return {
    requested: urls.length,
    deleted: deletedUrls.length,
    failed: failedDeletes.length,
    queued,
    queue_failed: failedDeletes.length - queued,
    ignored,
  }
}

if (queued > 0) {
  wakeMangaR2DeleteRetryWorker(DELETE_RETRY_DELAY_MS)
}

export async function uploadProcessedMangaParts({
  processed,
  folder,
}) {
  const sourceParts = Array.isArray(processed?.parts)
    ? processed.parts
    : []

  if (!sourceParts.length) {
    const error = new Error('Processed manga image has no parts to upload.')
    error.code = 'MANGA_PARTS_EMPTY'
    error.statusCode = 422
    throw error
  }

  const parts = sourceParts
    .map(normalizePart)
    .sort((a, b) => a.partIndex - b.partIndex)

  if (parts.some((part) => !part.buffer.length)) {
    const error = new Error('One or more processed manga parts are empty.')
    error.code = 'MANGA_PART_EMPTY'
    error.statusCode = 422
    throw error
  }

  const uploaded = []

  try {
    for (const part of parts) {
      const imageUrl = await uploadFileToR2(
        buildPartFile(part),
        folder
      )

      uploaded.push({
        part_index: part.partIndex,
        image_url: imageUrl,
        storage_path: getStoragePath(imageUrl),
        width: part.width || null,
        height: part.height || null,
        file_size: part.buffer.length,
        mime_type: 'image/webp',
        quality: part.quality,
      })
    }

    return {
      source_width: Number(processed?.sourceWidth || 0) || null,
      source_height: Number(processed?.sourceHeight || 0) || null,
      source_format: processed?.sourceFormat || null,
      width: Number(processed?.width || 0) || null,
      height: Number(processed?.height || 0) || null,
      part_count: uploaded.length,
      parts: uploaded,
    }
  } catch (error) {
    const rollback = await deleteStoredMangaParts(uploaded)

    if (!error.code) error.code = 'MANGA_PART_STORAGE_FAILED'
    if (!error.statusCode) error.statusCode = 500

    error.rollback = rollback
    throw error
  }
}
