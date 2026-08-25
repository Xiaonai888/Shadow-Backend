import { processMangaImage } from '../services/mangaImageProcessor.service.js'
import { supabase } from '../config/supabase.js'
import {
  deleteStoredMangaParts,
  uploadProcessedMangaParts,
} from '../services/mangaPageStorage.service.js'

const MANGA_IMAGE_MAX_BYTES = 5 * 1024 * 1024

function cleanHeader(value, maxLength = 300) {
  return String(value || '').trim().slice(0, maxLength)
}

function getRawFile(req) {
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  const contentType = cleanHeader(req.headers['content-type'], 120)
    .split(';')[0]
    .trim()
    .toLowerCase()
  const originalName =
    cleanHeader(req.headers['x-file-name'], 240) || 'manga-page'

  return {
    buffer,
    size: buffer.length,
    mimetype: contentType || 'application/octet-stream',
    originalname: originalName,
  }
}

function errorStage(error) {
  const code = String(error?.code || '')

  if (
    code.includes('DECODE') ||
    code.includes('DIMENSIONS_MISSING')
  ) {
    return 'decode'
  }

  if (
    code.includes('DIMENSIONS_TOO_LARGE') ||
    code.includes('EMPTY')
  ) {
    return 'validate'
  }

  if (code.includes('COMPRESSION')) {
    return 'compress'
  }

  return 'storage'
}

export async function uploadMangaPageImageV2(req, res) {
  const userId = req.user?.user_id

  if (!userId) {
    return res.status(401).json({
      ok: false,
      code: 'UNAUTHORIZED',
      stage: 'auth',
      message: 'Please sign in again before uploading an image.',
    })
  }

  const file = getRawFile(req)

  if (!file.size) {
    return res.status(400).json({
      ok: false,
      code: 'MANGA_IMAGE_BODY_EMPTY',
      stage: 'receive',
      message: 'No manga image data reached the server.',
    })
  }

  if (file.size > MANGA_IMAGE_MAX_BYTES) {
    return res.status(413).json({
      ok: false,
      code: 'MANGA_PAGE_TOO_LARGE',
      stage: 'receive',
      message: 'Manga page must be 5 MB or smaller.',
      received_bytes: file.size,
      max_bytes: MANGA_IMAGE_MAX_BYTES,
    })
  }

  try {
    const processed = await processMangaImage(file)
    const stored = await uploadProcessedMangaParts({
      processed,
      folder: `episode-content/${userId}/manga-v2`,
    })
    const firstPart = stored.parts[0]
    const totalBytes = stored.parts.reduce(
      (sum, part) => sum + Number(part.file_size || 0),
      0
    )

    return res.status(201).json({
      ok: true,
      code: 'MANGA_PAGE_V2_UPLOADED',
      stage: 'complete',
      image_url: firstPart.image_url,
      imageUrl: firstPart.image_url,
      path: firstPart.storage_path,
      source_format: stored.source_format,
      source_width: stored.source_width,
      source_height: stored.source_height,
      source_bytes: file.size,
      width: stored.width,
      height: stored.height,
      file_size: totalBytes,
      mime_type: 'image/webp',
      part_count: stored.part_count,
      parts: stored.parts,
      page: {
        image_url: firstPart.image_url,
        storage_path: firstPart.storage_path,
        width: stored.width,
        height: stored.height,
        file_size: totalBytes,
        mime_type: 'image/webp',
        part_count: stored.part_count,
        parts: stored.parts,
      },
    })
  } catch (error) {
    console.error('MANGA PAGE V2 UPLOAD ERROR:', error)

    return res.status(Number(error?.statusCode) || 500).json({
      ok: false,
      code: error?.code || 'MANGA_PAGE_V2_UPLOAD_FAILED',
      stage: errorStage(error),
      message:
        error?.message ||
        'The manga page could not be processed or stored.',
      rollback: error?.rollback || null,
    })
  }
}

export async function cleanupTemporaryMangaPartsV2(req, res) {
  const userId = String(req.user?.user_id || '').trim()

  if (!userId) {
    return res.status(401).json({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Please sign in again.',
    })
  }

  const urls = [
    ...new Set(
      (Array.isArray(req.body?.urls) ? req.body.urls : [])
        .slice(0, 10)
        .map((url) => String(url || '').trim())
        .filter(Boolean)
    ),
  ]

  if (!urls.length) {
    return res.json({
      ok: true,
      requested: 0,
      protected: 0,
      deleted: 0,
      failed: 0,
    })
  }

  const publicBaseUrl = String(
    process.env.R2_PUBLIC_URL || ''
  ).replace(/\/+$/, '')

  if (!publicBaseUrl) {
    return res.status(500).json({
      ok: false,
      code: 'R2_PUBLIC_URL_MISSING',
      message: 'Storage configuration is unavailable.',
    })
  }

  const ownedPrefix =
    `${publicBaseUrl}/episode-content/${userId}/manga-v2/`

  if (urls.some((url) => !url.startsWith(ownedPrefix))) {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_MANGA_CLEANUP_URL',
      message: 'One or more manga files cannot be removed.',
    })
  }

  try {
    const [
      { data: partRows, error: partError },
      { data: pageRows, error: pageError },
    ] = await Promise.all([
      supabase
        .from('episode_page_parts')
        .select('image_url')
        .in('image_url', urls),
      supabase
        .from('episode_pages')
        .select('image_url')
        .in('image_url', urls),
    ])

    if (partError) throw partError
    if (pageError) throw pageError

    const protectedUrls = new Set([
      ...(partRows || []).map((row) => row.image_url),
      ...(pageRows || []).map((row) => row.image_url),
    ])

    const removableUrls = urls.filter(
      (url) => !protectedUrls.has(url)
    )

    const result = await deleteStoredMangaParts(
      removableUrls.map((imageUrl) => ({
        image_url: imageUrl,
      }))
    )

    return res.json({
      ok: true,
      requested: urls.length,
      protected: protectedUrls.size,
      deleted: result.deleted,
      failed: result.failed,
    })
  } catch (error) {
    console.error(
      'MANGA V2 TEMP CLEANUP ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      code: 'MANGA_V2_TEMP_CLEANUP_FAILED',
      message: 'Temporary manga files could not be cleaned up.',
    })
  }
}
