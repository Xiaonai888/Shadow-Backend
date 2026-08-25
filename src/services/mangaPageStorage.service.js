import {
  deleteR2ObjectByUrl,
  uploadFileToR2,
} from './r2Storage.service.js'

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

export async function deleteStoredMangaParts(parts = []) {
  const urls = (Array.isArray(parts) ? parts : [])
    .map((part) => part?.image_url || part?.imageUrl)
    .filter(Boolean)

  const results = await Promise.allSettled(
    urls.map((url) => deleteR2ObjectByUrl(url))
  )

  return {
    requested: urls.length,
    deleted: results.filter(
      (result) => result.status === 'fulfilled' && result.value === true
    ).length,
    failed: results.filter((result) => result.status === 'rejected').length,
  }
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
