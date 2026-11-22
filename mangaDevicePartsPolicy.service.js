export const MANGA_DEVICE_PARTS_LIMITS = Object.freeze({
  maxSourceWidth: 8000,
  maxSourceHeight: 30000,
  maxSourcePixels: 120_000_000,
  maxOutputWidth: 1440,
  maxOutputHeight: 30000,
  maxParts: 40,
  maxPartHeight: 3000,
  maxPartBytes: 2 * 1024 * 1024,
  maxTotalBytes: 24 * 1024 * 1024,
  overlapPixels: 2,
  maxSessionSeconds: 30 * 60,
  signedUrlSeconds: 5 * 60,
})

export function mangaDevicePartsError(statusCode, code, message, stage = 'device_parts') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  error.stage = stage
  return error
}

function integer(value, label, min, max) {
  if (value === null || value === undefined || value === '') {
    throw mangaDevicePartsError(422, 'MANGA_DEVICE_MANIFEST_INVALID', `${label} is required`, 'validate')
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw mangaDevicePartsError(422, 'MANGA_DEVICE_MANIFEST_INVALID', `${label} is out of range`, 'validate')
  }
  return number
}

export function validateMangaDevicePartsManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw mangaDevicePartsError(422, 'MANGA_DEVICE_MANIFEST_INVALID', 'Manga part manifest is required', 'validate')
  }

  const limits = MANGA_DEVICE_PARTS_LIMITS
  const sourceWidth = integer(input.sourceWidth, 'sourceWidth', 1, limits.maxSourceWidth)
  const sourceHeight = integer(input.sourceHeight, 'sourceHeight', 1, limits.maxSourceHeight)
  if (sourceWidth * sourceHeight > limits.maxSourcePixels) {
    throw mangaDevicePartsError(422, 'MANGA_DEVICE_SOURCE_TOO_LARGE', 'Source Manga dimensions exceed limits', 'validate')
  }

  const width = integer(input.width, 'width', 1, Math.min(sourceWidth, limits.maxOutputWidth))
  const height = integer(input.height, 'height', 1, limits.maxOutputHeight)
  const expectedHeight = Math.max(1, Math.round(sourceHeight * width / sourceWidth))
  if (height !== expectedHeight) {
    throw mangaDevicePartsError(422, 'MANGA_DEVICE_ASPECT_INVALID', 'Manga output dimensions do not match source aspect ratio', 'validate')
  }

  const rawParts = input.parts
  if (!Array.isArray(rawParts) || !rawParts.length || rawParts.length > limits.maxParts) {
    throw mangaDevicePartsError(422, 'MANGA_DEVICE_PART_COUNT_INVALID', 'Manga part count exceeds limits', 'validate')
  }

  let totalBytes = 0
  let previousEnd = 0
  const parts = rawParts.map((part, index) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw mangaDevicePartsError(422, 'MANGA_DEVICE_PART_INVALID', 'Manga part must be an object', 'validate')
    }
    const partIndex = integer(part.partIndex, 'partIndex', 0, limits.maxParts - 1)
    const top = integer(part.top, 'top', 0, height - 1)
    const partWidth = integer(part.width, 'part width', 1, width)
    const partHeight = integer(part.height, 'part height', 1, limits.maxPartHeight)
    const size = integer(part.size, 'part size', 32, limits.maxPartBytes)
    const quality = part.quality == null ? null : Number(part.quality)
    if (quality !== null && (!Number.isFinite(quality) || quality < 0 || quality > 1)) {
      throw mangaDevicePartsError(422, 'MANGA_DEVICE_PART_QUALITY_INVALID', 'Part quality is invalid', 'validate')
    }
    if (partIndex !== index || partWidth !== width || top + partHeight > height) {
      throw mangaDevicePartsError(422, 'MANGA_DEVICE_PART_GEOMETRY_INVALID', 'Part index, width or bounds are invalid', 'validate')
    }
    if (index === 0 && top !== 0) {
      throw mangaDevicePartsError(422, 'MANGA_DEVICE_PART_GAP', 'First part must begin at the top', 'validate')
    }
    if (index > 0 && top !== previousEnd - limits.overlapPixels) {
      throw mangaDevicePartsError(422, 'MANGA_DEVICE_PART_GAP', 'Manga parts must have the expected two-pixel overlap', 'validate')
    }
    previousEnd = top + partHeight
    totalBytes += size
    return { partIndex, top, width: partWidth, height: partHeight, size, quality }
  })

  if (previousEnd !== height || totalBytes > limits.maxTotalBytes) {
    throw mangaDevicePartsError(422, 'MANGA_DEVICE_PARTS_INCOMPLETE', 'Manga parts do not cover the page or exceed the byte limit', 'validate')
  }

  return { sourceWidth, sourceHeight, width, height, totalBytes, parts }
}
