import sharp from 'sharp'
import { uploadImageToR2AsWebP } from '../services/r2Storage.service.js'

const NOVEL_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const MANGA_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const OUTPUT_MAX_BYTES = 500 * 1024
const MANGA_MAX_WIDTH = 8000
const MANGA_MAX_HEIGHT = 30000
const MANGA_MAX_PIXELS = 120_000_000

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
    cleanHeader(req.headers['x-file-name'], 240) || 'episode-image'

  return {
    buffer,
    size: buffer.length,
    mimetype: contentType || 'application/octet-stream',
    originalname: originalName,
  }
}

function getStoragePath(imageUrl) {
  const publicBaseUrl = String(process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '')

  if (publicBaseUrl && imageUrl.startsWith(`${publicBaseUrl}/`)) {
    return imageUrl.slice(publicBaseUrl.length + 1)
  }

  return imageUrl
}

function isHeicFile(file) {
  const type = String(file?.mimetype || '').toLowerCase()
  const name = String(file?.originalname || '').toLowerCase()

  return /image\/hei[cf]/i.test(type) || /\.hei[cf]$/i.test(name)
}

async function inspectImage(file) {
  try {
    const metadata = await sharp(file.buffer).metadata()

    if (!metadata?.width || !metadata?.height) {
      const error = new Error('Image dimensions could not be detected.')
      error.code = 'IMAGE_DIMENSIONS_MISSING'
      error.statusCode = 415
      throw error
    }

    return metadata
  } catch (error) {
    if (error?.code === 'IMAGE_DIMENSIONS_MISSING') throw error

    const nextError = new Error(
      isHeicFile(file)
        ? 'The image reached the server, but this HEIC/HEIF file could not be decoded.'
        : 'The image reached the server, but its image data could not be decoded.'
    )

    nextError.code = isHeicFile(file)
      ? 'HEIC_DECODE_FAILED'
      : 'IMAGE_DECODE_FAILED'
    nextError.statusCode = 415
    throw nextError
  }
}

function sendUploadError(res, error, kind) {
  const message = String(error?.message || '')
  const upperKind = kind === 'novel' ? 'NOVEL_IMAGE' : 'MANGA_PAGE'

  if (error?.code && error?.statusCode) {
    return res.status(error.statusCode).json({
      ok: false,
      code: error.code,
      stage: 'decode',
      message,
    })
  }

  if (message.includes('Unable to compress image below')) {
    return res.status(422).json({
      ok: false,
      code: `${upperKind}_COMPRESSION_FAILED`,
      stage: 'compress',
      message: 'The image was received, but the server could not compress it to the required size.',
    })
  }

  if (
    message.includes('Missing R2_') ||
    message.includes('R2_BUCKET_NAME') ||
    message.includes('R2_PUBLIC_URL')
  ) {
    return res.status(500).json({
      ok: false,
      code: 'R2_CONFIGURATION_ERROR',
      stage: 'storage',
      message: 'The image was processed, but Cloudflare R2 storage is not configured correctly.',
    })
  }

  return res.status(error?.statusCode || 500).json({
    ok: false,
    code: error?.code || `${upperKind}_UPLOAD_FAILED`,
    stage: 'storage',
    message: 'The image reached the server, but it could not be stored in Cloudflare R2.',
  })
}

async function uploadRawImage({
  req,
  res,
  kind,
  maxBytes,
  folderName,
}) {
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
      code: 'IMAGE_BODY_EMPTY',
      stage: 'receive',
      message: 'No image data reached the server. Please choose the image and try again.',
    })
  }

  if (file.size > maxBytes) {
    return res.status(413).json({
      ok: false,
      code: kind === 'novel' ? 'NOVEL_IMAGE_TOO_LARGE' : 'MANGA_PAGE_TOO_LARGE',
      stage: 'receive',
      message:
        kind === 'novel'
          ? 'Novel image must be 5 MB or smaller.'
          : 'Manga page must be 5 MB or smaller.',
      received_bytes: file.size,
      max_bytes: maxBytes,
    })
  }

  try {
    const metadata = await inspectImage(file)
        if (
      kind === 'manga' &&
      (metadata.width > MANGA_MAX_WIDTH ||
        metadata.height > MANGA_MAX_HEIGHT ||
        metadata.width * metadata.height > MANGA_MAX_PIXELS)
    ) {
      return res.status(422).json({ ok: false, code: 'MANGA_PAGE_DIMENSIONS_TOO_LARGE', stage: 'validate', message: 'Manga image is too large. Max: 8000×30000px and 120MP.' })
    }

    const imageUrl = await uploadImageToR2AsWebP(
      file,
      `episode-content/${userId}/${folderName}`,
      {
        width: 1600,
        quality: 82,
        minQuality: 40,
        qualityStep: 6,
        maxBytes: OUTPUT_MAX_BYTES,
        fallbackWidth: 640,
      }
    )

    return res.status(201).json({
      ok: true,
      code: kind === 'novel' ? 'NOVEL_IMAGE_UPLOADED' : 'MANGA_PAGE_UPLOADED',
      stage: 'complete',
      image_url: imageUrl,
      imageUrl,
      path: getStoragePath(imageUrl),
      source_format: metadata.format || null,
      source_width: Number(metadata.width || 0),
      source_height: Number(metadata.height || 0),
      source_bytes: file.size,
    })
  } catch (error) {
    console.error(
      kind === 'novel'
        ? 'RAW NOVEL IMAGE UPLOAD ERROR:'
        : 'RAW MANGA PAGE UPLOAD ERROR:',
      error
    )

    return sendUploadError(res, error, kind)
  }
}

export async function uploadNovelEpisodeImage(req, res) {
  return uploadRawImage({
    req,
    res,
    kind: 'novel',
    maxBytes: NOVEL_IMAGE_MAX_BYTES,
    folderName: 'novel',
  })
}

export async function uploadMangaPageImage(req, res) {
  return uploadRawImage({
    req,
    res,
    kind: 'manga',
    maxBytes: MANGA_IMAGE_MAX_BYTES,
    folderName: 'manga',
  })
}
