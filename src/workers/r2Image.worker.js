import { copyFile, stat, unlink } from 'node:fs/promises'
import sharp from 'sharp'

sharp.cache(false)
sharp.concurrency(1)

function buildQualityLevels(startQuality, minQuality, step) {
  const levels = []
  let current = startQuality

  while (current > minQuality) {
    levels.push(current)
    current -= step
  }

  levels.push(minQuality)
  return [...new Set(levels)]
}

function buildResizeProfiles({
  width,
  height,
  fallbackWidth,
  fallbackHeight,
  maxBytes,
}) {
  const profiles = [{ width, height }]

  if (maxBytes > 0 && fallbackWidth > 0) {
    profiles.push({
      width: fallbackWidth,
      height:
        fallbackHeight ||
        (height
          ? Math.round(
              (fallbackWidth * height) / width
            )
          : null),
    })
  }

  if (maxBytes > 0 && height) {
    const ratio = height / width

    for (const nextWidth of [800, 640]) {
      if (
        nextWidth <
        profiles[profiles.length - 1].width
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
          item.width === profile.width &&
          item.height === profile.height
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

  const qualityLevels =
    options.maxBytes > 0
      ? buildQualityLevels(
          options.quality,
          options.minQuality,
          options.qualityStep
        )
      : [options.quality]

  const profiles = buildResizeProfiles(
    options
  )

  let smallestPath = ''
  let smallestSize =
    Number.POSITIVE_INFINITY
  let candidateIndex = 0

  try {
    for (const profile of profiles) {
      for (const quality of qualityLevels) {
        const candidatePath =
          `${outputPath}.${candidateIndex}.tmp.webp`
        candidateIndex += 1

        const resizeOptions = {
          width: profile.width,
          withoutEnlargement: true,
        }

        if (profile.height) {
          resizeOptions.height = profile.height
          resizeOptions.fit = options.fit
          resizeOptions.position = 'centre'
        }

        await sharp(inputPath, {
          failOn: 'none',
        })
          .rotate()
          .resize(resizeOptions)
          .webp({
            quality,
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

          smallestPath = candidatePath
          smallestSize = candidateStat.size
        } else {
          await unlink(
            candidatePath
          ).catch(() => {})
        }

        if (
          !options.maxBytes ||
          candidateStat.size <=
            options.maxBytes
        ) {
          await copyFile(
            smallestPath,
            outputPath
          )
          return
        }
      }
    }

    if (
      options.maxBytes &&
      smallestSize > options.maxBytes
    ) {
      throw new Error(
        `Unable to compress image below ${Math.round(
          options.maxBytes / 1024
        )} KB`
      )
    }

    if (!smallestPath) {
      throw new Error(
        'Image optimization failed'
      )
    }

    await copyFile(
      smallestPath,
      outputPath
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
