import sharp from 'sharp'

export const MANGA_PROCESSOR_LIMITS = Object.freeze({
  maxWidth: 8000,
  maxHeight: 30000,
  maxPixels: 120_000_000,
  targetWidth: 1600,
  partMaxHeight: 5000,
  targetPartBytes: 1536 * 1024,
  hardPartBytes: 2 * 1024 * 1024,
})

const WIDTH_FALLBACKS = [1600, 1440, 1280, 1120]
const QUALITY_LEVELS = [88, 85, 82, 79, 76, 73, 70, 67, 64]

function positiveInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0
    ? Math.max(1, Math.round(number))
    : fallback
}

function orientedDimensions(metadata) {
  const width = positiveInteger(metadata?.width)
  const height = positiveInteger(metadata?.height)
  const orientation = Number(metadata?.orientation || 1)

  if ([5, 6, 7, 8].includes(orientation)) {
    return { width: height, height: width }
  }

  return { width, height }
}

function validateDimensions(width, height) {
  const { maxWidth, maxHeight, maxPixels } = MANGA_PROCESSOR_LIMITS

  if (!width || !height) {
    const error = new Error('Manga image dimensions could not be detected.')
    error.code = 'MANGA_IMAGE_DIMENSIONS_MISSING'
    error.statusCode = 415
    throw error
  }

  if (
    width > maxWidth ||
    height > maxHeight ||
    width * height > maxPixels
  ) {
    const error = new Error(
      'Manga image is too large. Max: 8000×30000px and 120MP.'
    )
    error.code = 'MANGA_PAGE_DIMENSIONS_TOO_LARGE'
    error.statusCode = 422
    throw error
  }
}

function widthProfiles(sourceWidth) {
  return WIDTH_FALLBACKS
    .map((width) => Math.min(width, sourceWidth))
    .filter(
      (width, index, list) =>
        width > 0 && list.indexOf(width) === index
    )
}

async function renderRawPart({
  fileBuffer,
  pageWidth,
  pageHeight,
  top,
  height,
}) {
  return sharp(fileBuffer, {
    limitInputPixels: MANGA_PROCESSOR_LIMITS.maxPixels,
    sequentialRead: true,
  })
    .rotate()
    .resize({
      width: pageWidth,
      height: pageHeight,
      fit: 'fill',
      withoutEnlargement: true,
    })
    .extract({
      left: 0,
      top,
      width: pageWidth,
      height,
    })
    .raw()
    .toBuffer({ resolveWithObject: true })
}

async function compressRawPart(rawData, rawInfo) {
  let hardCandidate = null

  for (const quality of QUALITY_LEVELS) {
    const buffer = await sharp(rawData, {
      raw: {
        width: rawInfo.width,
        height: rawInfo.height,
        channels: rawInfo.channels,
      },
    })
      .webp({
        quality,
        effort: 4,
        smartSubsample: true,
      })
      .toBuffer()

    if (
      !hardCandidate &&
      buffer.length <= MANGA_PROCESSOR_LIMITS.hardPartBytes
    ) {
      hardCandidate = { buffer, quality }
    }

    if (buffer.length <= MANGA_PROCESSOR_LIMITS.targetPartBytes) {
      return { buffer, quality }
    }
  }

  return hardCandidate
}

async function processAtWidth(fileBuffer, sourceWidth, sourceHeight, pageWidth) {
  const ratio = pageWidth / sourceWidth
  const pageHeight = Math.max(1, Math.round(sourceHeight * ratio))
  const partCount = Math.ceil(
    pageHeight / MANGA_PROCESSOR_LIMITS.partMaxHeight
  )
  const parts = []

  for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
    const top = partIndex * MANGA_PROCESSOR_LIMITS.partMaxHeight
    const height = Math.min(
      MANGA_PROCESSOR_LIMITS.partMaxHeight,
      pageHeight - top
    )
    const raw = await renderRawPart({
      fileBuffer,
      pageWidth,
      pageHeight,
      top,
      height,
    })
    const compressed = await compressRawPart(raw.data, raw.info)

    if (!compressed) return null

    parts.push({
      partIndex,
      buffer: compressed.buffer,
      width: raw.info.width,
      height: raw.info.height,
      fileSize: compressed.buffer.length,
      mimeType: 'image/webp',
      quality: compressed.quality,
    })
  }

  return {
    width: pageWidth,
    height: pageHeight,
    parts,
  }
}

export async function processMangaImage(file) {
  const fileBuffer = Buffer.isBuffer(file?.buffer)
    ? file.buffer
    : Buffer.alloc(0)

  if (!fileBuffer.length) {
    const error = new Error('Manga image data is empty.')
    error.code = 'MANGA_IMAGE_EMPTY'
    error.statusCode = 400
    throw error
  }

  let metadata

  try {
    metadata = await sharp(fileBuffer).metadata()
  } catch {
    const error = new Error('Manga image data could not be decoded.')
    error.code = 'MANGA_IMAGE_DECODE_FAILED'
    error.statusCode = 415
    throw error
  }

  const source = orientedDimensions(metadata)

  validateDimensions(source.width, source.height)

  for (const pageWidth of widthProfiles(source.width)) {
    const processed = await processAtWidth(
      fileBuffer,
      source.width,
      source.height,
      pageWidth
    )

    if (processed) {
      return {
        sourceWidth: source.width,
        sourceHeight: source.height,
        sourceFormat: metadata.format || null,
        width: processed.width,
        height: processed.height,
        partCount: processed.parts.length,
        parts: processed.parts,
      }
    }
  }

  const error = new Error(
    'Manga image could not be compressed below 2 MB per part.'
  )
  error.code = 'MANGA_PART_COMPRESSION_FAILED'
  error.statusCode = 422
  throw error
}
