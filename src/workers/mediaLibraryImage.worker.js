import { copyFile, stat, unlink } from 'node:fs/promises'
import sharp from 'sharp'

const MAX_IMAGE_BYTES = 300 * 1024
const RESIZE_WIDTHS = [768, 640, 512, 384, 320, 256]
const QUALITY_LEVELS = [82, 76, 70, 64, 58, 52, 46, 40]

sharp.cache(false)
sharp.concurrency(1)

async function main() {
  const inputPath = String(process.argv[2] || '').trim()
  const outputPath = String(process.argv[3] || '').trim()

  if (!inputPath || !outputPath) {
    throw new Error('Input and output paths are required')
  }

  const metadata = await sharp(inputPath, {
    failOn: 'none',
  }).metadata()

  const width = Number(metadata.width || 0)
  const height = Number(metadata.height || 0)
  const format = String(metadata.format || '').toLowerCase()
  const inputStat = await stat(inputPath)

  if (
    format === 'webp' &&
    inputStat.size <= MAX_IMAGE_BYTES &&
    width > 0 &&
    height > 0 &&
    width <= 768 &&
    height <= 768
  ) {
    await copyFile(inputPath, outputPath)
    return
  }

  let smallestPath = ''
  let smallestSize = Number.POSITIVE_INFINITY

  for (const maxWidth of RESIZE_WIDTHS) {
    for (const quality of QUALITY_LEVELS) {
      const candidatePath =
        `${outputPath}.${maxWidth}-${quality}.tmp`

      try {
        await sharp(inputPath, {
          failOn: 'none',
        })
          .rotate()
          .resize({
            width: maxWidth,
            height: maxWidth,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({
            quality,
            effort: 4,
            smartSubsample: true,
          })
          .toFile(candidatePath)

        const candidateStat = await stat(candidatePath)

        if (candidateStat.size < smallestSize) {
          if (smallestPath) {
            await unlink(smallestPath).catch(() => {})
          }

          smallestPath = candidatePath
          smallestSize = candidateStat.size
        } else {
          await unlink(candidatePath).catch(() => {})
        }

        if (candidateStat.size <= MAX_IMAGE_BYTES) {
          await copyFile(candidatePath, outputPath)

          if (smallestPath) {
            await unlink(smallestPath).catch(() => {})
          }

          return
        }
      } catch (error) {
        await unlink(candidatePath).catch(() => {})
        throw error
      }
    }
  }

  if (!smallestPath) {
    throw new Error('Image optimization failed')
  }

  await copyFile(smallestPath, outputPath)
  await unlink(smallestPath).catch(() => {})
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error)
  process.exitCode = 1
})
