import { copyFile, stat, unlink } from 'node:fs/promises'
import sharp from 'sharp'

sharp.cache(false)
sharp.concurrency(1)

function numberOption(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number)
    ? number
    : fallback
}

function buildQualityLevels(
  startQuality,
  minQuality,
  step
) {
  const levels = []
  let current = startQuality

  while (current > minQuality) {
    levels.push(current)
    current -= step
  }

  levels.push(minQuality)
  return [...new Set(levels)]
}

function buildResizeProfiles(options) {
  const width = numberOption(
    options.width,
    1600
  )
  const height = options.height
    ? numberOption(options.height, 0)
    : null
  const fallbackWidth =
    numberOption(
      options.fallbackWidth,
      0
    )
  const fallbackHeight =
    options.fallbackHeight
      ? numberOption(
          options.fallbackHeight,
          0
        )
      : null
  const maxBytes = numberOption(
    options.maxBytes,
    0
  )
  const profiles = [
    { width, height },
  ]

  if (
    maxBytes > 0 &&
    fallbackWidth > 0
  ) {
    profiles.push({
      width: fallbackWidth,
      height:
        fallbackHeight ||
        (height
          ? Math.round(
              (fallbackWidth * height) /
                width
            )
          : null),
    })
  }

  if (maxBytes > 0 && height) {
    const ratio = height / width

    for (const nextWidth of [
      800,
      640,
    ]) {
      if (
        nextWidth <
        profiles[
          profiles.length - 1
        ].width
      ) {
        profiles.push({
          width: nextWidth,
          height: Math.round(
            nextWidth * ratio
          ),
        })
      }
    }
  }

  return profiles.filter(
    (profile, index, list) =>
      index ===
      list.findIndex(
        (item) =>
          item.width ===
            profile.width &&
          item.height ===
            profile.height
      )
  )
}

async function main() {
  const inputPath = String(
    process.argv[2] || ''
  ).trim()
  const outputPath = String(
    process.argv[3] || ''
  ).trim()
  const options = JSON.parse(
    String(process.argv[4] || '{}')
  )

  if (!inputPath || !outputPath) {
    throw new Error(
      'Input and output paths are required'
    )
  }

  let metadata

  try {
    metadata = await sharp(inputPath, {
      failOn: 'none',
    }).metadata()
  } catch {
    throw new Error(
      'STORY_IMAGE_DECODE_FAILED'
    )
  }

  if (
    !metadata?.width ||
    !metadata?.height
  ) {
    throw new Error(
      'IMAGE_DIMENSIONS_MISSING'
    )
  }

  const maxWidth = numberOption(
    options.maxSourceWidth,
    0
  )
  const maxHeight = numberOption(
    options.maxSourceHeight,
    0
  )
  const maxPixels = numberOption(
    options.maxSourcePixels,
    0
  )
  const pixels =
    Number(metadata.width) *
    Number(metadata.height)

  if (
    (maxWidth > 0 &&
      metadata.width > maxWidth) ||
    (maxHeight > 0 &&
      metadata.height > maxHeight) ||
    (maxPixels > 0 &&
      pixels > maxPixels)
  ) {
    throw new Error(
      'MANGA_PAGE_DIMENSIONS_TOO_LARGE'
    )
  }

  const quality = numberOption(
    options.quality,
    82
  )
  const minQuality = numberOption(
    options.minQuality,
    40
  )
  const qualityStep = numberOption(
    options.qualityStep,
    6
  )
  const maxBytes = numberOption(
    options.maxBytes,
    0
  )
  const fit =
    options.fit === 'contain'
      ? 'contain'
      : 'cover'
  const qualityLevels =
    maxBytes > 0
      ? buildQualityLevels(
          quality,
          minQuality,
          qualityStep
        )
      : [quality]
  const profiles =
    buildResizeProfiles(options)

  let smallestPath = ''
  let smallestSize =
    Number.POSITIVE_INFINITY
  let candidateIndex = 0

  try {
    for (const profile of profiles) {
      for (
        const currentQuality of
        qualityLevels
      ) {
        const candidatePath =
          `${outputPath}.${candidateIndex}.tmp.webp`
        candidateIndex += 1

        const resizeOptions = {
          width: profile.width,
          withoutEnlargement: true,
        }

        if (profile.height) {
          resizeOptions.height =
            profile.height
          resizeOptions.fit = fit
          resizeOptions.position =
            'centre'
        }

        await sharp(inputPath, {
          failOn: 'none',
        })
          .rotate()
          .resize(resizeOptions)
          .webp({
            quality: currentQuality,
            effort: 4,
            smartSubsample: true,
          })
          .toFile(candidatePath)

        const candidateStat =
          await stat(candidatePath)

        if (
          candidateStat.size <
          smallestSize
        ) {
          if (smallestPath) {
            await unlink(
              smallestPath
            ).catch(() => {})
          }

          smallestPath =
            candidatePath
          smallestSize =
            candidateStat.size
        } else {
          await unlink(
            candidatePath
          ).catch(() => {})
        }

        if (
          !maxBytes ||
          candidateStat.size <=
            maxBytes
        ) {
          await copyFile(
            smallestPath,
            outputPath
          )

          process.stdout.write(
            JSON.stringify({
              format:
                metadata.format ||
                null,
              width: Number(
                metadata.width || 0
              ),
              height: Number(
                metadata.height || 0
              ),
            })
          )
          return
        }
      }
    }

    if (
      maxBytes &&
      smallestSize > maxBytes
    ) {
      throw new Error(
        `STORY_IMAGE_COMPRESS_LIMIT: Unable to compress image below ${Math.round(
          maxBytes / 1024
        )} KB`
      )
    }

    if (!smallestPath) {
      throw new Error(
        'STORY_IMAGE_PROCESSING_FAILED'
      )
    }

    await copyFile(
      smallestPath,
      outputPath
    )

    process.stdout.write(
      JSON.stringify({
        format:
          metadata.format || null,
        width: Number(
          metadata.width || 0
        ),
        height: Number(
          metadata.height || 0
        ),
      })
    )
  } finally {
    if (smallestPath) {
      await unlink(
        smallestPath
      ).catch(() => {})
    }
  }
}

main().catch((error) => {
  console.error(
    error?.stack ||
      error?.message ||
      error
  )
  process.exitCode = 1
})
