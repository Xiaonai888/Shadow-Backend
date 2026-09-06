import sharp from 'sharp'

export const MANGA_PROCESSOR_LIMITS = Object.freeze({
  maxWidth: 8000,
  maxHeight: 30000,
  maxPixels: 120_000_000,
  targetWidth: 1600,
  partPreferredHeight: 4200,
  partMaxHeight: 5200,
  partEmergencyMaxHeight: 6200,
  partMinHeight: 1400,
  partEmergencyMinHeight: 900,
  cutSearchRadius: 1400,
  cutAnalysisWidth: 360,
  cutBandHeight: 280,
  cutStep: 24,
  partOverlap: 2,
  targetPartBytes: 1792 * 1024,
  hardPartBytes: 2 * 1024 * 1024,
})

const WIDTH_FALLBACKS = [1600, 1440, 1280, 1120]
const QUALITY_LEVELS = [86, 80, 74, 68, 62]

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

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

async function buildCutAnalysis({
  fileBuffer,
  pageWidth,
  pageHeight,
}) {
  const analysisWidth = Math.max(
    1,
    Math.min(MANGA_PROCESSOR_LIMITS.cutAnalysisWidth, pageWidth)
  )
  const analysisHeight = Math.max(
    1,
    Math.round(pageHeight * (analysisWidth / pageWidth))
  )

  const raw = await sharp(fileBuffer, {
    limitInputPixels: MANGA_PROCESSOR_LIMITS.maxPixels,
    sequentialRead: true,
  })
    .rotate()
    .resize({
      width: analysisWidth,
      height: analysisHeight,
      fit: 'fill',
      withoutEnlargement: true,
    })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  return {
    data: raw.data,
    width: raw.info.width,
    height: raw.info.height,
    scaleY: raw.info.height / pageHeight,
  }
}

function scoreCutCandidate({ analysis, pageY, targetY }) {
  const { data, width, height, scaleY } = analysis

  if (!data?.length || !width || height < 3) {
    return Number.POSITIVE_INFINITY
  }

  const centerY = clamp(
    Math.round(pageY * scaleY),
    1,
    height - 2
  )
  const bandRadius = Math.max(
    1,
    Math.round(
      (MANGA_PROCESSOR_LIMITS.cutBandHeight / 2) *
        scaleY
    )
  )
  const guardRadius = Math.max(
    1,
    Math.round(60 * scaleY)
  )
  const startY = clamp(
    centerY - bandRadius,
    1,
    height - 2
  )
  const endY = clamp(
    centerY + bandRadius,
    1,
    height - 2
  )
  const guardStartY = clamp(
    centerY - guardRadius,
    1,
    height - 2
  )
  const guardEndY = clamp(
    centerY + guardRadius,
    1,
    height - 2
  )

  let valueSum = 0
  let valueSquareSum = 0
  let pixelCount = 0
  let horizontalDifference = 0
  let horizontalCount = 0
  let verticalDifference = 0
  let verticalCount = 0
  let busyCount = 0
  let nearWhiteCount = 0

  for (let y = startY; y <= endY; y += 1) {
    const rowOffset = y * width
    const previousRowOffset = (y - 1) * width

    for (let x = 0; x < width; x += 1) {
      const value = data[rowOffset + x]

      valueSum += value
      valueSquareSum += value * value
      pixelCount += 1

      if (value >= 242) {
        nearWhiteCount += 1
      }

      if (x > 0) {
        const difference = Math.abs(
          value - data[rowOffset + x - 1]
        )

        horizontalDifference += difference
        horizontalCount += 1

        if (difference >= 24) {
          busyCount += 1
        }
      }

      const vertical = Math.abs(
        value - data[previousRowOffset + x]
      )

      verticalDifference += vertical
      verticalCount += 1

      if (vertical >= 24) {
        busyCount += 1
      }
    }
  }

  if (!pixelCount) {
    return Number.POSITIVE_INFINITY
  }

  const sectionCount = Math.min(8, width)
  const sectionWidth = Math.max(
    1,
    Math.ceil(width / sectionCount)
  )
  const sectionBusy = Array(sectionCount).fill(0)
  const sectionSamples = Array(sectionCount).fill(0)

  let guardDifference = 0
  let guardSamples = 0
  let guardBusy = 0

  for (
    let y = guardStartY;
    y <= guardEndY;
    y += 1
  ) {
    const rowOffset = y * width
    const previousRowOffset = (y - 1) * width

    for (let x = 0; x < width; x += 1) {
      const value = data[rowOffset + x]
      const vertical = Math.abs(
        value - data[previousRowOffset + x]
      )
      const horizontal =
        x > 0
          ? Math.abs(
              value - data[rowOffset + x - 1]
            )
          : 0

      const localDifference = Math.max(
        horizontal,
        vertical
      )
      const sectionIndex = Math.min(
        sectionCount - 1,
        Math.floor(x / sectionWidth)
      )

      guardDifference += localDifference
      guardSamples += 1
      sectionSamples[sectionIndex] += 1

      if (localDifference >= 22) {
        guardBusy += 1
        sectionBusy[sectionIndex] += 1
      }
    }
  }

  const mean = valueSum / pixelCount
  const variance = Math.max(
    0,
    valueSquareSum / pixelCount - mean * mean
  )
  const standardDeviation = Math.sqrt(variance)

  const horizontalEdge =
    horizontalDifference /
    Math.max(1, horizontalCount) /
    255
  const verticalEdge =
    verticalDifference /
    Math.max(1, verticalCount) /
    255
  const busyRatio =
    busyCount /
    Math.max(
      1,
      horizontalCount + verticalCount
    )
  const whiteRatio =
    nearWhiteCount / pixelCount
  const varianceScore = Math.min(
    1,
    standardDeviation / 96
  )
  const distancePenalty =
    Math.abs(pageY - targetY) /
    Math.max(
      1,
      MANGA_PROCESSOR_LIMITS.cutSearchRadius
    )

  const guardEdge =
    guardDifference /
    Math.max(1, guardSamples) /
    255
  const guardBusyRatio =
    guardBusy / Math.max(1, guardSamples)

  const peakSectionBusyRatio = sectionBusy.reduce(
    (peak, count, index) => {
      const ratio =
        count /
        Math.max(1, sectionSamples[index])

      return Math.max(peak, ratio)
    },
    0
  )

  const unsafeGuardPenalty =
    guardBusyRatio > 0.16
      ? (guardBusyRatio - 0.16) * 2.4
      : 0

  const unsafeSectionPenalty =
    peakSectionBusyRatio > 0.28
      ? (peakSectionBusyRatio - 0.28) * 2.8
      : 0

  return (
    varianceScore * 0.32 +
    horizontalEdge * 0.55 +
    verticalEdge * 0.65 +
    busyRatio * 0.72 +
    guardEdge * 1.15 +
    guardBusyRatio * 1.5 +
    peakSectionBusyRatio * 1.25 +
    unsafeGuardPenalty +
    unsafeSectionPenalty +
    distancePenalty * 0.1 -
    whiteRatio * 0.14
  )
}

function findSafestCut({
  analysis,
  targetY,
  minimumY,
  maximumY,
}) {
  const minimum = Math.ceil(minimumY)
  const maximum = Math.floor(maximumY)

  if (minimum > maximum) return null

  if (minimum === maximum) {
    return minimum
  }

  let bestY = clamp(
    Math.round(targetY),
    minimum,
    maximum
  )
  let bestScore = scoreCutCandidate({
    analysis,
    pageY: bestY,
    targetY,
  })

  const evaluate = (candidateY) => {
    const y = clamp(
      Math.round(candidateY),
      minimum,
      maximum
    )
    const score = scoreCutCandidate({
      analysis,
      pageY: y,
      targetY,
    })

    if (score < bestScore) {
      bestScore = score
      bestY = y
    }
  }

  for (
    let candidateY = minimum;
    candidateY <= maximum;
    candidateY += MANGA_PROCESSOR_LIMITS.cutStep
  ) {
    evaluate(candidateY)
  }

  const refineStart = Math.max(
    minimum,
    bestY - MANGA_PROCESSOR_LIMITS.cutStep
  )
  const refineEnd = Math.min(
    maximum,
    bestY + MANGA_PROCESSOR_LIMITS.cutStep
  )

  for (
    let candidateY = refineStart;
    candidateY <= refineEnd;
    candidateY += 1
  ) {
    evaluate(candidateY)
  }

  return bestY
}

async function buildSmartPartRanges({
  fileBuffer,
  pageWidth,
  pageHeight,
}) {
  const {
    partPreferredHeight,
    partMaxHeight,
    partEmergencyMaxHeight,
    partMinHeight,
    partEmergencyMinHeight,
    cutSearchRadius,
    partOverlap,
  } = MANGA_PROCESSOR_LIMITS

  if (pageHeight <= partMaxHeight) {
    return [{ top: 0, height: pageHeight }]
  }

  const partCount = Math.ceil(pageHeight / partPreferredHeight)
  const analysis = await buildCutAnalysis({
    fileBuffer,
    pageWidth,
    pageHeight,
  })

  const cuts = []
  let previousCut = 0

  for (let cutIndex = 1; cutIndex < partCount; cutIndex += 1) {
    const remainingParts = partCount - cutIndex
    const targetY = Math.round((pageHeight * cutIndex) / partCount)

    const minimumY = Math.max(
      previousCut + partMinHeight,
      pageHeight - remainingParts * partMaxHeight
    )

    const maximumY = Math.min(
      previousCut + partMaxHeight,
      pageHeight - remainingParts * partMinHeight
    )

    const searchCenterY = clamp(targetY, minimumY, maximumY)
    const searchMinimumY = Math.max(
      minimumY,
      searchCenterY - cutSearchRadius
    )
    const searchMaximumY = Math.min(
      maximumY,
      searchCenterY + cutSearchRadius
    )

    let cutY = findSafestCut({
      analysis,
      targetY,
      minimumY: searchMinimumY,
      maximumY: searchMaximumY,
    })

    if (cutY === null) {
      const emergencyMinimumY = Math.max(
        previousCut + partEmergencyMinHeight,
        pageHeight -
          remainingParts *
            partEmergencyMaxHeight
      )

      const emergencyMaximumY = Math.min(
        previousCut + partEmergencyMaxHeight,
        pageHeight -
          remainingParts *
            partEmergencyMinHeight
      )

      cutY = findSafestCut({
        analysis,
          targetY,
        minimumY: emergencyMinimumY,
        maximumY: emergencyMaximumY,
      })
    }

    if (cutY === null) {
      const error = new Error(
        'No safe manga cut position could be found.'
      )
      error.code = 'MANGA_SAFE_CUT_NOT_FOUND'
      error.statusCode = 422
      throw error
    }

    cuts.push(cutY)
    previousCut = cutY
  }

  const ranges = []
  let top = 0

  for (const cutY of cuts) {
    ranges.push({ top, height: cutY - top })
    top = Math.max(0, cutY - partOverlap)
  }

  ranges.push({ top, height: pageHeight - top })

  return ranges.filter((range) => range.height > 0)
}

function mapPageRangeToSource({
  sourceHeight,
  pageHeight,
  top,
  height,
}) {
  const scaleY = sourceHeight / pageHeight
  const sourceTop = clamp(
    Math.floor(top * scaleY),
    0,
    Math.max(0, sourceHeight - 1)
  )
  const sourceBottom = clamp(
    Math.ceil((top + height) * scaleY),
    sourceTop + 1,
    sourceHeight
  )

  return {
    top: sourceTop,
    height: sourceBottom - sourceTop,
  }
}

async function encodeMangaPart({
  fileBuffer,
  sourceWidth,
  sourceHeight,
  pageWidth,
  pageHeight,
  top,
  height,
  quality,
}) {
  const sourceRange = mapPageRangeToSource({
    sourceHeight,
    pageHeight,
    top,
    height,
  })

  return sharp(fileBuffer, {
    limitInputPixels: MANGA_PROCESSOR_LIMITS.maxPixels,
    sequentialRead: true,
  })
    .rotate()
    .extract({
      left: 0,
      top: sourceRange.top,
      width: sourceWidth,
      height: sourceRange.height,
    })
    .resize({
      width: pageWidth,
      height,
      fit: 'fill',
      withoutEnlargement: true,
    })
    .sharpen({ sigma: 0.45 })
    .webp({
      quality,
      effort: 3,
      smartSubsample: true,
    })
    .toBuffer({ resolveWithObject: true })
}

async function compressMangaPart(options) {
  let hardCandidate = null

  for (const quality of QUALITY_LEVELS) {
    const encoded = await encodeMangaPart({
      ...options,
      quality,
    })
    const candidate = {
      buffer: encoded.data,
      width: encoded.info.width,
      height: encoded.info.height,
      quality,
    }

    if (
      !hardCandidate &&
      encoded.data.length <= MANGA_PROCESSOR_LIMITS.hardPartBytes
    ) {
      hardCandidate = candidate
    }

    if (
      encoded.data.length <= MANGA_PROCESSOR_LIMITS.targetPartBytes
    ) {
      return candidate
    }
  }

  return hardCandidate
}

async function processAtWidth(
  fileBuffer,
  sourceWidth,
  sourceHeight,
  pageWidth
) {
  const ratio = pageWidth / sourceWidth
  const pageHeight = Math.max(
    1,
    Math.round(sourceHeight * ratio)
  )
  const ranges = await buildSmartPartRanges({
    fileBuffer,
    pageWidth,
    pageHeight,
  })
  const parts = []

  for (let partIndex = 0; partIndex < ranges.length; partIndex += 1) {
    const range = ranges[partIndex]
    const compressed = await compressMangaPart({
      fileBuffer,
      sourceWidth,
      sourceHeight,
      pageWidth,
      pageHeight,
      top: range.top,
      height: range.height,
    })

    if (!compressed) return null

    parts.push({
      partIndex,
      buffer: compressed.buffer,
      width: compressed.width,
      height: compressed.height,
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
