import { randomUUID } from 'node:crypto'
import { stat, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

export const MANGA_PROCESSOR_LIMITS = Object.freeze({
  maxWidth: 8000,
  maxHeight: 30000,
  maxPixels: 120_000_000,
  targetWidth: 1440,
  partPreferredHeight: 2400,
  partMaxHeight: 3000,
  partEmergencyMaxHeight: 3600,
  partMinHeight: 800,
  partEmergencyMinHeight: 650,
  cutSearchRadius: 1000,
  cutAnalysisWidth: 220,
  cutBandHeight: 240,
  cutStep: 32,
  partOverlap: 2,
  hardPartBytes: 2 * 1024 * 1024,
  primaryQuality: 82,
  fallbackQuality: 72,
})

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

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

async function safeUnlink(filePath) {
  if (!filePath) return
  await unlink(filePath).catch(() => {})
}

async function buildCutAnalysis({
  filePath,
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

  const raw = await sharp(filePath, {
    limitInputPixels: MANGA_PROCESSOR_LIMITS.maxPixels,
    sequentialRead: true,
  })
    .rotate()
    .resize({
      width: analysisWidth,
      height: analysisHeight,
      fit: 'fill',
      withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3,
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
      (MANGA_PROCESSOR_LIMITS.cutBandHeight / 2) * scaleY
    )
  )
  const guardRadius = Math.max(1, Math.round(72 * scaleY))
  const startY = clamp(centerY - bandRadius, 1, height - 2)
  const endY = clamp(centerY + bandRadius, 1, height - 2)
  const guardStartY = clamp(centerY - guardRadius, 1, height - 2)
  const guardEndY = clamp(centerY + guardRadius, 1, height - 2)

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

      if (value >= 242) nearWhiteCount += 1

      if (x > 0) {
        const difference = Math.abs(value - data[rowOffset + x - 1])
        horizontalDifference += difference
        horizontalCount += 1
        if (difference >= 24) busyCount += 1
      }

      const vertical = Math.abs(value - data[previousRowOffset + x])
      verticalDifference += vertical
      verticalCount += 1
      if (vertical >= 24) busyCount += 1
    }
  }

  if (!pixelCount) return Number.POSITIVE_INFINITY

  const sectionCount = Math.min(8, width)
  const sectionWidth = Math.max(1, Math.ceil(width / sectionCount))
  const sectionBusy = Array(sectionCount).fill(0)
  const sectionSamples = Array(sectionCount).fill(0)
  let guardDifference = 0
  let guardSamples = 0
  let guardBusy = 0

  for (let y = guardStartY; y <= guardEndY; y += 1) {
    const rowOffset = y * width
    const previousRowOffset = (y - 1) * width

    for (let x = 0; x < width; x += 1) {
      const value = data[rowOffset + x]
      const vertical = Math.abs(value - data[previousRowOffset + x])
      const horizontal =
        x > 0 ? Math.abs(value - data[rowOffset + x - 1]) : 0
      const localDifference = Math.max(horizontal, vertical)
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
    horizontalDifference / Math.max(1, horizontalCount) / 255
  const verticalEdge =
    verticalDifference / Math.max(1, verticalCount) / 255
  const busyRatio =
    busyCount / Math.max(1, horizontalCount + verticalCount)
  const whiteRatio = nearWhiteCount / pixelCount
  const varianceScore = Math.min(1, standardDeviation / 96)
  const distancePenalty =
    Math.abs(pageY - targetY) /
    Math.max(1, MANGA_PROCESSOR_LIMITS.cutSearchRadius)
  const guardEdge =
    guardDifference / Math.max(1, guardSamples) / 255
  const guardBusyRatio = guardBusy / Math.max(1, guardSamples)
  const peakSectionBusyRatio = sectionBusy.reduce(
    (peak, count, index) =>
      Math.max(
        peak,
        count / Math.max(1, sectionSamples[index])
      ),
    0
  )
  const unsafeGuardPenalty =
    guardBusyRatio > 0.14
      ? (guardBusyRatio - 0.14) * 2.8
      : 0
  const unsafeSectionPenalty =
    peakSectionBusyRatio > 0.24
      ? (peakSectionBusyRatio - 0.24) * 3.2
      : 0

  return (
    varianceScore * 0.32 +
    horizontalEdge * 0.55 +
    verticalEdge * 0.65 +
    busyRatio * 0.72 +
    guardEdge * 1.25 +
    guardBusyRatio * 1.7 +
    peakSectionBusyRatio * 1.4 +
    unsafeGuardPenalty +
    unsafeSectionPenalty +
    distancePenalty * 0.1 -
    whiteRatio * 0.16
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
  if (minimum === maximum) return minimum

  let bestY = clamp(Math.round(targetY), minimum, maximum)
  let bestScore = scoreCutCandidate({
    analysis,
    pageY: bestY,
    targetY,
  })

  const evaluate = (candidateY) => {
    const y = clamp(Math.round(candidateY), minimum, maximum)
    const score = scoreCutCandidate({ analysis, pageY: y, targetY })

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
  filePath,
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
    return {
      analysis: null,
      ranges: [{ top: 0, height: pageHeight }],
    }
  }

  const analysis = await buildCutAnalysis({
    filePath,
    pageWidth,
    pageHeight,
  })
  const partCount = Math.ceil(pageHeight / partPreferredHeight)
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
        pageHeight - remainingParts * partEmergencyMaxHeight
      )
      const emergencyMaximumY = Math.min(
        previousCut + partEmergencyMaxHeight,
        pageHeight - remainingParts * partEmergencyMinHeight
      )

      cutY = findSafestCut({
        analysis,
        targetY,
        minimumY: emergencyMinimumY,
        maximumY: emergencyMaximumY,
      })
    }

    if (cutY === null) {
      const error = new Error('No safe manga cut position could be found.')
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

  return {
    analysis,
    ranges: ranges.filter((range) => range.height > 0),
  }
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

async function encodeRangeToFile({
  filePath,
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
  const outputPath = path.join(
    os.tmpdir(),
    `manga-encoded-${Date.now()}-${randomUUID()}.webp`
  )

  try {
    const info = await sharp(filePath, {
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
        kernel: sharp.kernel.lanczos3,
      })
      .webp({
        quality,
        effort: 2,
        smartSubsample: true,
      })
      .toFile(outputPath)

    const fileStat = await stat(outputPath)

    return {
      path: outputPath,
      size: Number(fileStat.size || info.size || 0),
      width: Number(info.width || pageWidth),
      height: Number(info.height || height),
      quality,
    }
  } catch (error) {
    await safeUnlink(outputPath)
    throw error
  }
}

async function compressRangeToFile(options) {
  const first = await encodeRangeToFile({
    ...options,
    quality: MANGA_PROCESSOR_LIMITS.primaryQuality,
  })

  if (first.size <= MANGA_PROCESSOR_LIMITS.hardPartBytes) {
    return first
  }

  await safeUnlink(first.path)

  const second = await encodeRangeToFile({
    ...options,
    quality: MANGA_PROCESSOR_LIMITS.fallbackQuality,
  })

  if (second.size <= MANGA_PROCESSOR_LIMITS.hardPartBytes) {
    return second
  }

  await safeUnlink(second.path)
  return null
}

function splitOversizedRange({
  range,
  analysis,
  pageHeight,
}) {
  const minimumChildHeight = Math.min(
    MANGA_PROCESSOR_LIMITS.partEmergencyMinHeight,
    Math.max(320, Math.floor(range.height / 3))
  )

  if (range.height < minimumChildHeight * 2 + 2) {
    return null
  }

  const minimumY = range.top + minimumChildHeight
  const maximumY = range.top + range.height - minimumChildHeight
  const targetY = Math.round(range.top + range.height / 2)
  let cutY = analysis
    ? findSafestCut({
        analysis,
        targetY,
        minimumY,
        maximumY,
      })
    : targetY

  cutY = clamp(cutY ?? targetY, minimumY, maximumY)

  if (cutY <= range.top || cutY >= range.top + range.height) {
    return null
  }

  const overlap = MANGA_PROCESSOR_LIMITS.partOverlap
  const first = {
    top: range.top,
    height: cutY - range.top,
  }
  const secondTop = Math.max(range.top, cutY - overlap)
  const second = {
    top: secondTop,
    height: Math.min(
      pageHeight - secondTop,
      range.top + range.height - secondTop
    ),
  }

  return [first, second].filter((item) => item.height > 0)
}

export async function processMangaImage(file, { onPart } = {}) {
  sharp.cache(false)
  sharp.concurrency(1)

  const filePath = String(file?.path || '').trim()

  if (!filePath) {
    const error = new Error('Manga image must use disk-backed temporary storage.')
    error.code = 'MANGA_IMAGE_PATH_REQUIRED'
    error.statusCode = 500
    throw error
  }

  if (typeof onPart !== 'function') {
    const error = new Error('Manga part uploader is required.')
    error.code = 'MANGA_PART_UPLOADER_REQUIRED'
    error.statusCode = 500
    throw error
  }

  let metadata

  try {
    metadata = await sharp(filePath).metadata()
  } catch {
    const error = new Error('Manga image data could not be decoded.')
    error.code = 'MANGA_IMAGE_DECODE_FAILED'
    error.statusCode = 415
    throw error
  }

  const source = orientedDimensions(metadata)
  validateDimensions(source.width, source.height)

  const pageWidth = Math.min(
    MANGA_PROCESSOR_LIMITS.targetWidth,
    source.width
  )
  const ratio = pageWidth / source.width
  const pageHeight = Math.max(
    1,
    Math.round(source.height * ratio)
  )
  const plan = await buildSmartPartRanges({
    filePath,
    pageWidth,
    pageHeight,
  })
  const queue = [...plan.ranges]
  const storedParts = []
  let partIndex = 0

  while (queue.length > 0) {
    const range = queue.shift()
    const encoded = await compressRangeToFile({
      filePath,
      sourceWidth: source.width,
      sourceHeight: source.height,
      pageWidth,
      pageHeight,
      top: range.top,
      height: range.height,
    })

    if (!encoded) {
      const split = splitOversizedRange({
        range,
        analysis: plan.analysis,
        pageHeight,
      })

      if (!split) {
        const error = new Error(
          'Manga image could not be compressed below 2 MB per part.'
        )
        error.code = 'MANGA_PART_COMPRESSION_FAILED'
        error.statusCode = 422
        throw error
      }

      queue.unshift(...split)
      continue
    }

    try {
      const stored = await onPart({
        partIndex,
        path: encoded.path,
        size: encoded.size,
        width: encoded.width,
        height: encoded.height,
        fileSize: encoded.size,
        mimeType: 'image/webp',
        quality: encoded.quality,
      })

      storedParts.push(stored)
      partIndex += 1
    } finally {
      await safeUnlink(encoded.path)
    }
  }

  return {
    sourceWidth: source.width,
    sourceHeight: source.height,
    sourceFormat: metadata.format || null,
    width: pageWidth,
    height: pageHeight,
    partCount: storedParts.length,
    parts: storedParts,
  }
}
