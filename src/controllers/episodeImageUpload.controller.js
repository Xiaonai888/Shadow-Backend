import {
  uploadFileToR2,
} from '../services/r2Storage.service.js'
import {
  cleanupStoryImageResult,
  processStoryImageFile,
} from '../services/storyImagePipeline.service.js'

const NOVEL_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const MANGA_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const OUTPUT_MAX_BYTES = 500 * 1024
const MANGA_MAX_WIDTH = 8000
const MANGA_MAX_HEIGHT = 30000
const MANGA_MAX_PIXELS = 120_000_000

function getRawFile(req) {
  if (!req.file?.path) {
    return null
  }

  return {
    path: req.file.path,
    size: Number(req.file.size || 0),
    mimetype:
      String(
        req.file.mimetype ||
          'application/octet-stream'
      )
        .trim()
        .toLowerCase(),
    originalname:
      String(
        req.file.originalname ||
          'episode-image'
      ).trim(),
  }
}

function getStoragePath(imageUrl) {
  const publicBaseUrl = String(
    process.env.R2_PUBLIC_URL || ''
  ).replace(/\/+$/, '')

  if (
    publicBaseUrl &&
    imageUrl.startsWith(
      `${publicBaseUrl}/`
    )
  ) {
    return imageUrl.slice(
      publicBaseUrl.length + 1
    )
  }

  return imageUrl
}

function isHeicFile(file) {
  const type = String(
    file?.mimetype || ''
  ).toLowerCase()
  const name = String(
    file?.originalname || ''
  ).toLowerCase()

  return (
    /image\/hei[cf]/i.test(type) ||
    /\.hei[cf]$/i.test(name)
  )
}

function sendUploadError(
  res,
  error,
  kind,
  file
) {
  const message = String(
    error?.message || ''
  )
  const upperKind =
    kind === 'novel'
      ? 'NOVEL_IMAGE'
      : 'MANGA_PAGE'

  if (
    error?.code ===
    'STORY_IMAGE_DECODE_FAILED'
  ) {
    return res.status(415).json({
      ok: false,
      code: isHeicFile(file)
        ? 'HEIC_DECODE_FAILED'
        : 'IMAGE_DECODE_FAILED',
      stage: 'decode',
      message: isHeicFile(file)
        ? 'The image reached the server, but this HEIC/HEIF file could not be decoded.'
        : 'The image reached the server, but its image data could not be decoded.',
    })
  }

  if (
    error?.code &&
    error?.statusCode
  ) {
    return res
      .status(error.statusCode)
      .json({
        ok: false,
        code: error.code,
        stage:
          error.code ===
          'STORY_IMAGE_COMPRESS_LIMIT'
            ? 'compress'
            : 'decode',
        message:
          error.code ===
          'STORY_IMAGE_COMPRESS_LIMIT'
            ? 'The image was received, but the server could not compress it to the required size.'
            : message,
      })
  }

  if (
    message.includes(
      'Unable to compress image below'
    )
  ) {
    return res.status(422).json({
      ok: false,
      code:
        `${upperKind}_COMPRESSION_FAILED`,
      stage: 'compress',
      message:
        'The image was received, but the server could not compress it to the required size.',
    })
  }

  if (
    message.includes('Missing R2_') ||
    message.includes(
      'R2_BUCKET_NAME'
    ) ||
    message.includes('R2_PUBLIC_URL')
  ) {
    return res.status(500).json({
      ok: false,
      code:
        'R2_CONFIGURATION_ERROR',
      stage: 'storage',
      message:
        'The image was processed, but Cloudflare R2 storage is not configured correctly.',
    })
  }

  return res
    .status(
      error?.statusCode || 500
    )
    .json({
      ok: false,
      code:
        error?.code ||
        `${upperKind}_UPLOAD_FAILED`,
      stage: 'storage',
      message:
        'The image reached the server, but it could not be stored in Cloudflare R2.',
    })
}

async function uploadRawImage({
  req,
  res,
  kind,
  maxBytes,
  folderName,
}) {
  const userId =
    req.user?.user_id

  if (!userId) {
    return res.status(401).json({
      ok: false,
      code: 'UNAUTHORIZED',
      stage: 'auth',
      message:
        'Please sign in again before uploading an image.',
    })
  }

  const file = getRawFile(req)

  if (!file?.size) {
    return res.status(400).json({
      ok: false,
      code: 'IMAGE_BODY_EMPTY',
      stage: 'receive',
      message:
        'No image data reached the server. Please choose the image and try again.',
    })
  }

  if (file.size > maxBytes) {
    return res.status(413).json({
      ok: false,
      code:
        kind === 'novel'
          ? 'NOVEL_IMAGE_TOO_LARGE'
          : 'MANGA_PAGE_TOO_LARGE',
      stage: 'receive',
      message:
        kind === 'novel'
          ? 'Novel image must be 5 MB or smaller.'
          : 'Manga page must be 5 MB or smaller.',
      received_bytes: file.size,
      max_bytes: maxBytes,
    })
  }

  let processed = null

  try {
    processed =
      await processStoryImageFile(
        file,
        {
          width: 1600,
          quality: 82,
          minQuality: 40,
          qualityStep: 6,
          maxBytes:
            OUTPUT_MAX_BYTES,
          fallbackWidth: 640,
          maxSourceWidth:
            kind === 'manga'
              ? MANGA_MAX_WIDTH
              : 0,
          maxSourceHeight:
            kind === 'manga'
              ? MANGA_MAX_HEIGHT
              : 0,
          maxSourcePixels:
            kind === 'manga'
              ? MANGA_MAX_PIXELS
              : 0,
        }
      )

    const imageUrl =
      await uploadFileToR2(
        {
          path: processed.path,
          size: processed.size,
          mimetype: 'image/webp',
          originalname:
            'episode-image.webp',
        },
        `episode-content/${userId}/${folderName}`
      )

    return res.status(201).json({
      ok: true,
      code:
        kind === 'novel'
          ? 'NOVEL_IMAGE_UPLOADED'
          : 'MANGA_PAGE_UPLOADED',
      stage: 'complete',
      image_url: imageUrl,
      imageUrl,
      path:
        getStoragePath(imageUrl),
      source_format:
        processed.metadata
          .format || null,
      source_width: Number(
        processed.metadata.width || 0
      ),
      source_height: Number(
        processed.metadata.height || 0
      ),
      source_bytes: file.size,
    })
  } catch (error) {
    console.error(
      kind === 'novel'
        ? 'RAW NOVEL IMAGE UPLOAD ERROR:'
        : 'RAW MANGA PAGE UPLOAD ERROR:',
      error
    )

    return sendUploadError(
      res,
      error,
      kind,
      file
    )
  } finally {
    await cleanupStoryImageResult(
      processed
    )
  }
}

export async function uploadNovelEpisodeImage(
  req,
  res
) {
  return uploadRawImage({
    req,
    res,
    kind: 'novel',
    maxBytes:
      NOVEL_IMAGE_MAX_BYTES,
    folderName: 'novel',
  })
}

export async function uploadMangaPageImage(
  req,
  res
) {
  return uploadRawImage({
    req,
    res,
    kind: 'manga',
    maxBytes:
      MANGA_IMAGE_MAX_BYTES,
    folderName: 'manga',
  })
}
