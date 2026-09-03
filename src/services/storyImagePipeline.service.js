import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateHeavyJobAdmission } from './memoryGuard.service.js'

const WORKER_TIMEOUT_MS = 3 * 60 * 1000
const ADMISSION_TIMEOUT_MS = 5 * 60 * 1000
const ADMISSION_POLL_MS = 1000
const ESTIMATED_IMAGE_WORKER_MB = 140
const WORKER_PATH = fileURLToPath(
  new URL('../workers/storyImagePipeline.worker.js', import.meta.url)
)

let processingTail = Promise.resolve()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForAdmission() {
  const startedAt = Date.now()
  let lastAdmission = null

  while (Date.now() - startedAt < ADMISSION_TIMEOUT_MS) {
    lastAdmission = evaluateHeavyJobAdmission({
      jobType: 'story_image_pipeline',
      estimatedJobMb: ESTIMATED_IMAGE_WORKER_MB,
    })

    if (lastAdmission.allowed) {
      return lastAdmission
    }

    await sleep(ADMISSION_POLL_MS)
  }

  const error = new Error(
    'Image processing is temporarily busy. Please retry shortly.'
  )
  error.statusCode = 503
  error.code = 'STORY_IMAGE_PROCESSING_BUSY'
  error.admission = lastAdmission
  throw error
}

function workerError(stderr) {
  const text = String(stderr || '').trim()

  if (text.includes('MANGA_PAGE_DIMENSIONS_TOO_LARGE')) {
    const error = new Error(
      'Manga image is too large. Max: 8000×30000px and 120MP.'
    )
    error.statusCode = 422
    error.code = 'MANGA_PAGE_DIMENSIONS_TOO_LARGE'
    return error
  }

  if (text.includes('IMAGE_DIMENSIONS_MISSING')) {
    const error = new Error(
      'Image dimensions could not be detected.'
    )
    error.statusCode = 415
    error.code = 'IMAGE_DIMENSIONS_MISSING'
    return error
  }

  if (text.includes('STORY_IMAGE_DECODE_FAILED')) {
    const error = new Error(
      'The image data could not be decoded.'
    )
    error.statusCode = 415
    error.code = 'STORY_IMAGE_DECODE_FAILED'
    return error
  }

  if (text.includes('STORY_IMAGE_COMPRESS_LIMIT')) {
    const match = text.match(
      /Unable to compress image below \d+ KB/
    )
    const error = new Error(
      match?.[0] ||
        'Unable to compress image below the required size'
    )
    error.statusCode = 422
    error.code = 'STORY_IMAGE_COMPRESS_LIMIT'
    return error
  }

  const error = new Error(
    text || 'Image processing failed'
  )
  error.statusCode = 500
  error.code = 'STORY_IMAGE_PROCESSING_FAILED'
  return error
}

function runWorker(inputPath, outputPath, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        WORKER_PATH,
        inputPath,
        outputPath,
        JSON.stringify(options),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (error = null, result = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (error) reject(error)
      else resolve(result)
    }

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '')
      if (stdout.length > 4000) {
        stdout = stdout.slice(-4000)
      }
    })

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '')
      if (stderr.length > 6000) {
        stderr = stderr.slice(-6000)
      }
    })

    child.once('error', (error) => {
      error.statusCode = error.statusCode || 500
      error.code =
        error.code || 'STORY_IMAGE_PROCESSING_FAILED'
      finish(error)
    })

    child.once('exit', (code, signal) => {
      if (code !== 0) {
        finish(
          workerError(
            stderr ||
              `Image worker exited with code ${code ?? 'unknown'}${
                signal ? ` (${signal})` : ''
              }`
          )
        )
        return
      }

      try {
        const result = JSON.parse(stdout.trim() || '{}')
        finish(null, result)
      } catch {
        finish(
          workerError(
            'Image worker returned invalid metadata'
          )
        )
      }
    })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      const error = new Error(
        'Image processing timed out'
      )
      error.statusCode = 503
      error.code = 'STORY_IMAGE_PROCESSING_TIMEOUT'
      finish(error)
    }, WORKER_TIMEOUT_MS)

    timer.unref?.()
  })
}

async function processNow(file, options) {
  if (!file?.path) {
    const error = new Error(
      'Temporary image file is required'
    )
    error.statusCode = 400
    error.code = 'STORY_IMAGE_FILE_REQUIRED'
    throw error
  }

  await waitForAdmission()

  const outputPath = path.join(
    os.tmpdir(),
    `story-image-${Date.now()}-${randomUUID()}.webp`
  )

  try {
    const metadata = await runWorker(
      file.path,
      outputPath,
      options
    )
    const outputStat = await stat(outputPath)

    if (
      !outputStat.isFile() ||
      outputStat.size <= 0
    ) {
      const error = new Error(
        'Image worker produced an empty file'
      )
      error.statusCode = 500
      error.code =
        'STORY_IMAGE_PROCESSING_FAILED'
      throw error
    }

    return {
      path: outputPath,
      size: outputStat.size,
      mimetype: 'image/webp',
      originalname: 'image.webp',
      metadata: {
        format:
          String(metadata?.format || '') ||
          null,
        width: Number(
          metadata?.width || 0
        ),
        height: Number(
          metadata?.height || 0
        ),
      },
    }
  } catch (error) {
    await unlink(outputPath).catch(() => {})
    throw error
  }
}

export function processStoryImageFile(
  file,
  options = {}
) {
  const job = processingTail.then(
    () => processNow(file, options),
    () => processNow(file, options)
  )

  processingTail = job.then(
    () => undefined,
    () => undefined
  )

  return job
}

export async function cleanupStoryImageResult(
  result
) {
  const filePath = String(
    result?.path || ''
  ).trim()

  if (!filePath) return
  await unlink(filePath).catch(() => {})
}
