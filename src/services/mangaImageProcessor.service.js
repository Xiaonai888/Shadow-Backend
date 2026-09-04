import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { loadOpenCV } from '@opencvjs/node'

export const MANGA_PROCESSOR_LIMITS = Object.freeze({
  maxWidth: 8000,
  maxHeight: 30000,
  maxPixels: 120_000_000,
  targetWidth: 1600,
  partPreferredHeight: 5000,
  partMaxHeight: 6200,
  partEmergencyMaxHeight: 7600,
  partMinHeight: 1600,
  partEmergencyMinHeight: 1000,
  cutSearchRadius: 1800,
  cutAnalysisWidth: 480,
  cutBandHeight: 260,
  cutStep: 16,
  partOverlap: 2,
  targetPartBytes: 1792 * 1024,
  hardPartBytes: 2 * 1024 * 1024,
})

const WIDTH_FALLBACKS = [1600, 1440, 1280, 1120]
const QUALITY_LEVELS = [92, 90, 88, 85, 82, 79, 76, 73, 70, 67, 64]

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

const ANIME_FACE_CASCADE_FILE = 'lbpcascade_animeface.xml'
const ANIME_FACE_CASCADE_URL = new URL(
  '../models/lbpcascade_animeface.xml',
  import.meta.url
)
const FACE_DETECTION_MAX_WIDTH = 720
const FACE_DETECTION_STRIP_HEIGHT = 2400
const FACE_DETECTION_STRIP_OVERLAP = 256

let animeFaceDetectorPromise = null

async function getAnimeFaceDetector() {
  if (!animeFaceDetectorPromise) {
    animeFaceDetectorPromise = (async () => {
      const cv = await loadOpenCV()
      const bytes = new Uint8Array(
        await readFile(ANIME_FACE_CASCADE_URL)
      )

      try {
        cv.FS_createDataFile(
          '/',
          ANIME_FACE_CASCADE_FILE,
          bytes,
          true,
          false,
          false
        )
      } catch {
      }

      const classifier = new cv.CascadeClassifier()
      classifier.load(ANIME_FACE_CASCADE_FILE)

      if (classifier.empty()) {
        classifier.delete()
        throw new Error('Anime face classifier could not be loaded.')
      }

      return { cv, classifier }
    })().catch((error) => {
      animeFaceDetectorPromise = null
      throw error
    })
  }

  return animeFaceDetectorPromise
}

function mergeFaceZones(zones) {
  const sorted = [...zones].sort(
    (a, b) => a.top - b.top
  )
  const merged = []

  for (const zone of sorted) {
    const previous = merged[merged.length - 1]

    if (
      previous &&
      zone.top <= previous.bottom + 24
    ) {
      previous.bottom = Math.max(
        previous.bottom,
        zone.bottom
      )
      continue
    }

    merged.push({ ...zone })
  }

  return merged
}

async function detectMangaFaceZones({
  fileBuffer,
  pageWidth,
  pageHeight,
}) {
  try {
    const { cv, classifier } =
      await getAnimeFaceDetector()

    const detectionScale = Math.min(
      1,
      FACE_DETECTION_MAX_WIDTH / pageWidth
    )
    const detectionWidth = Math.max(
      1,
      Math.round(pageWidth * detectionScale)
    )
    const detectionHeight = Math.max(
      1,
      Math.round(pageHeight * detectionScale)
    )
    const stripHeight = Math.min(
      FACE_DETECTION_STRIP_HEIGHT,
      detectionHeight
    )
    const stripOverlap = Math.min(
      FACE_DETECTION_STRIP_OVERLAP,
      Math.max(0, stripHeight - 1)
    )
    const stripStep = Math.max(
      1,
      stripHeight - stripOverlap
    )
    const scaleY = pageHeight / detectionHeight
    const zones = []

    for (
      let stripTop = 0;
      stripTop < detectionHeight;
      stripTop += stripStep
    ) {
      const currentHeight = Math.min(
        stripHeight,
        detectionHeight - stripTop
      )

      let src = null
      let gray = null
      let equalized = null
      let faces = null

      try {
        const raw = await sharp(fileBuffer, {
          limitInputPixels:
            MANGA_PROCESSOR_LIMITS.maxPixels,
          sequentialRead: true,
        })
          .rotate()
          .resize({
            width: detectionWidth,
            height: detectionHeight,
            fit: 'fill',
            withoutEnlargement: true,
          })
          .extract({
            left: 0,
            top: stripTop,
            width: detectionWidth,
            height: currentHeight,
          })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })

        src = new cv.Mat(
          raw.info.height,
          raw.info.width,
          cv.CV_8UC4
        )
        src.data.set(raw.data)

        gray = new cv.Mat()
        equalized = new cv.Mat()
        faces = new cv.RectVector()

        cv.cvtColor(
          src,
          gray,
          cv.COLOR_RGBA2GRAY,
          0
        )
        cv.equalizeHist(gray, equalized)

        classifier.detectMultiScale(
          equalized,
          faces,
          1.1,
          5,
          0,
          new cv.Size(24, 24),
          new cv.Size(0, 0)
        )

        for (
          let index = 0;
          index < faces.size();
          index += 1
        ) {
          const face = faces.get(index)
          const faceTop =
            (stripTop + face.y) * scaleY
          const faceHeight = face.height * scaleY
          const padding = Math.max(
            48,
            Math.round(faceHeight * 0.35)
          )

          zones.push({
            top: Math.max(
              0,
              Math.floor(faceTop - padding)
            ),
            bottom: Math.min(
              pageHeight,
              Math.ceil(
                faceTop +
                  faceHeight +
                  padding
              )
            ),
          })
        }
      } finally {
        if (faces) faces.delete()
        if (equalized) equalized.delete()
        if (gray) gray.delete()
        if (src) src.delete()
      }

      if (stripTop + currentHeight >= detectionHeight) {
        break
      }
    }

    return mergeFaceZones(zones)
  } catch (error) {
    console.error('MANGA FACE DETECTION ERROR:', error)

    const detectionError = new Error('Manga face detection failed.')
    detectionError.code = 'MANGA_FACE_DETECTION_FAILED'
    detectionError.statusCode = 503
    throw detectionError
  }
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

function cutCrossesFace(faceZones, pageY) {
  return faceZones.some(
    (zone) =>
      pageY >= zone.top &&
      pageY <= zone.bottom
  )
}

function findSafestCut({
  analysis,
  faceZones = [],
  targetY,
  minimumY,
  maximumY,
}) {
  const minimum = Math.ceil(minimumY)
  const maximum = Math.floor(maximumY)

  if (minimum >= maximum) {
    const candidateY = clamp(
      Math.round(targetY),
      minimum,
      maximum
    )

    return cutCrossesFace(
      faceZones,
      candidateY
    )
      ? null
      : candidateY
  }

  let bestY = null
  let bestScore = Number.POSITIVE_INFINITY

  const evaluate = (candidateY) => {
    const y = clamp(
      Math.round(candidateY),
      minimum,
      maximum
    )

    if (cutCrossesFace(faceZones, y)) {
      return
    }

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

  evaluate(targetY)

  for (
    let candidateY = minimum;
    candidateY <= maximum;
    candidateY += MANGA_PROCESSOR_LIMITS.cutStep
  ) {
    evaluate(candidateY)
  }

  if (bestY === null) {
    return null
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

  const faceZones = await detectMangaFaceZones({
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
      faceZones,
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
        faceZones,
        targetY,
        minimumY: emergencyMinimumY,
        maximumY: emergencyMaximumY,
      })
    }

    if (cutY === null) {
      const error = new Error(
        'No face-safe manga cut position could be found.'
      )
      error.code = 'MANGA_FACE_SAFE_CUT_NOT_FOUND'
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
.sharpen({ sigma: 0.5 })
.extract({
      left: 0,
      top,
      width: pageWidth,
      height,
    })
    .raw()
    .toBuffer({ resolveWithObject: true })
}

async function encodeRawPart(rawData, rawInfo, quality) {
  return sharp(rawData, {
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
}

async function measureRawPartQualities(rawData, rawInfo) {
  let hardQuality = null

  for (const quality of QUALITY_LEVELS) {
    const buffer = await encodeRawPart(rawData, rawInfo, quality)

    if (
      hardQuality === null &&
      buffer.length <= MANGA_PROCESSOR_LIMITS.hardPartBytes
    ) {
      hardQuality = quality
    }

    if (buffer.length <= MANGA_PROCESSOR_LIMITS.targetPartBytes) {
      return {
        targetQuality: quality,
        hardQuality: hardQuality ?? quality,
      }
    }
  }

  return {
    targetQuality: null,
    hardQuality,
  }
}

async function processAtWidth(fileBuffer, sourceWidth, sourceHeight, pageWidth) {
  const ratio = pageWidth / sourceWidth
  const pageHeight = Math.max(1, Math.round(sourceHeight * ratio))
  const ranges = await buildSmartPartRanges({
    fileBuffer,
    pageWidth,
    pageHeight,
  })
  const qualityChecks = []

  for (const range of ranges) {
    const raw = await renderRawPart({
      fileBuffer,
      pageWidth,
      pageHeight,
      top: range.top,
      height: range.height,
    })
    const check = await measureRawPartQualities(raw.data, raw.info)

    if (check.hardQuality === null) return null

    qualityChecks.push(check)
  }

  const targetReady = qualityChecks.every(
    (check) => check.targetQuality !== null
  )

  const commonQuality = Math.min(
    ...qualityChecks.map((check) =>
      targetReady ? check.targetQuality : check.hardQuality
    )
  )

  const maximumBytes = targetReady
    ? MANGA_PROCESSOR_LIMITS.targetPartBytes
    : MANGA_PROCESSOR_LIMITS.hardPartBytes

  const parts = []

  for (let partIndex = 0; partIndex < ranges.length; partIndex += 1) {
    const range = ranges[partIndex]
    const raw = await renderRawPart({
      fileBuffer,
      pageWidth,
      pageHeight,
      top: range.top,
      height: range.height,
    })
    const buffer = await encodeRawPart(
      raw.data,
      raw.info,
      commonQuality
    )

    if (buffer.length > maximumBytes) return null

    parts.push({
      partIndex,
      buffer,
      width: raw.info.width,
      height: raw.info.height,
      fileSize: buffer.length,
      mimeType: 'image/webp',
      quality: commonQuality,
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
