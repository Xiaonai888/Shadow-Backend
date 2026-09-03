import { copyFile, stat, unlink } from 'node:fs/promises'
import sharp from 'sharp'

const MAX_IMAGE_OUTPUT_BYTES = Math.floor(1.5 * 1024 * 1024)
const ATTEMPTS = [
  { width: 1080, height: 1920, quality: 82 },
  { width: 1080, height: 1920, quality: 74 },
  { width: 900, height: 1600, quality: 76 },
  { width: 900, height: 1600, quality: 68 },
  { width: 720, height: 1280, quality: 72 },
  { width: 720, height: 1280, quality: 62 },
  { width: 540, height: 960, quality: 58 },
]

sharp.cache(false)
sharp.concurrency(1)

async function main() {
  const inputPath = String(process.argv[2] || '').trim()
  const outputPath = String(process.argv[3] || '').trim()

  if (!inputPath || !outputPath) {
    throw new Error('Input and output paths are required')
  }

  for (let index = 0; index < ATTEMPTS.length; index += 1) {
    const attempt = ATTEMPTS[index]
    const candidatePath = `${outputPath}.${index}.tmp.webp`

    try {
      await sharp(inputPath, { failOn: 'none' })
        .rotate()
        .resize({
          width: attempt.width,
          height: attempt.height,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({
          quality: attempt.quality,
          effort: 4,
        })
        .toFile(candidatePath)

      const candidateStat = await stat(candidatePath)

      if (candidateStat.size <= MAX_IMAGE_OUTPUT_BYTES) {
        await copyFile(candidatePath, outputPath)
        await unlink(candidatePath).catch(() => {})
        return
      }
    } finally {
      await unlink(candidatePath).catch(() => {})
    }
  }

  throw new Error('STORY_IMAGE_OPTIMIZE_FAILED: Photo could not be optimized below 1.5 MB')
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error)
  process.exitCode = 1
})
