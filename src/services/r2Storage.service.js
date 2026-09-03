import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { evaluateHeavyJobAdmission } from './memoryGuard.service.js'

const WORKER_TIMEOUT_MS = 3 * 60 * 1000
const ADMISSION_TIMEOUT_MS = 5 * 60 * 1000
const ADMISSION_POLL_MS = 1000
const ESTIMATED_IMAGE_WORKER_MB = 140
const R2_IMAGE_WORKER_PATH = fileURLToPath(
  new URL('../workers/r2Image.worker.js', import.meta.url)
)

let sharpPromise = null
let r2Client = null
let imageProcessingTail = Promise.resolve()

async function getSharp() {
  if (!sharpPromise) {
    sharpPromise = import('sharp').then((module) => module.default)
  }

  return sharpPromise
}

function getR2Client() {
  if (r2Client) return r2Client

  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY')
  }

  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })

  return r2Client
}

function getR2BucketName() {
  const bucketName = process.env.R2_BUCKET_NAME

  if (!bucketName) {
    throw new Error('Missing R2_BUCKET_NAME')
  }

  return bucketName
}

function getR2PublicUrl() {
  const publicUrl = process.env.R2_PUBLIC_URL

  if (!publicUrl) {
    throw new Error('Missing R2_PUBLIC_URL')
  }

  return publicUrl.replace(/\/+$/, '')
}

function getSafeExtension(file) {
  const originalName = file?.originalname || 'file'
  const fileExt = originalName.includes('.') ? originalName.split('.').pop() : ''
  const safeExt = String(fileExt || '').toLowerCase().replace(/[^a-z0-9]/g, '')

  if (safeExt) return safeExt
  if (file?.mimetype === 'application/pdf') return 'pdf'
  if (file?.mimetype === 'image/webp') return 'webp'
  if (file?.mimetype === 'image/png') return 'png'
  if (file?.mimetype === 'image/jpeg') return 'jpg'

  return 'jpg'
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value)

  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)))
}

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
        (height ? Math.round((fallbackWidth * height) / width) : null),
    })
  }

  if (maxBytes > 0 && height) {
    const ratio = height / width

    for (const nextWidth of [800, 640]) {
      if (nextWidth < profiles[profiles.length - 1].width) {
        profiles.push({
          width: nextWidth,
          height: Math.round(nextWidth * ratio),
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

async function createWebPBuffer(fileBuffer, profile, quality, fit) {
  const resizeOptions = {
    width: profile.width,
    withoutEnlargement: true,
  }

  if (profile.height) {
    resizeOptions.height = profile.height
    resizeOptions.fit = fit
    resizeOptions.position = 'centre'
  }

  const sharp = await getSharp()

  return sharp(fileBuffer)
    .rotate()
    .resize(resizeOptions)
    .webp({
      quality,
      effort: 4,
      smartSubsample: true,
    })
    .toBuffer()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForImageWorkerAdmission() {
  const startedAt = Date.now()
  let lastAdmission = null

  while (Date.now() - startedAt < ADMISSION_TIMEOUT_MS) {
    lastAdmission = evaluateHeavyJobAdmission({
      jobType: 'r2_image',
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
  error.code = 'R2_IMAGE_PROCESSING_BUSY'
  error.admission = lastAdmission
  throw error
}

function runImageWorker(inputPath, outputPath, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        R2_IMAGE_WORKER_PATH,
        inputPath,
        outputPath,
        JSON.stringify(options),
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    )

    let stderr = ''
    let settled = false

    const finish = (error = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (error) reject(error)
      else resolve()
    }

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '')
      if (stderr.length > 4000) {
        stderr = stderr.slice(-4000)
      }
    })

    child.once('error', (error) => {
      error.statusCode = error.statusCode || 500
      error.code = error.code || 'R2_IMAGE_PROCESSING_FAILED'
      finish(error)
    })

    child.once('exit', (code, signal) => {
      if (code === 0) {
        finish()
        return
      }

      const compressLimit = stderr.includes(
        'Unable to compress image below'
      )
      const error = new Error(
        stderr.trim() ||
          `Image worker exited with code ${code ?? 'unknown'}${
            signal ? ` (${signal})` : ''
          }`
      )

      error.statusCode = compressLimit ? 422 : 500
      error.code = compressLimit
        ? 'R2_IMAGE_COMPRESS_LIMIT'
        : 'R2_IMAGE_PROCESSING_FAILED'
      finish(error)
    })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      const error = new Error('Image processing timed out')
      error.statusCode = 503
      error.code = 'R2_IMAGE_PROCESSING_TIMEOUT'
      finish(error)
    }, WORKER_TIMEOUT_MS)

    timer.unref?.()
  })
}

async function optimizePathToWebP(inputPath, options) {
  await waitForImageWorkerAdmission()

  const outputPath = path.join(
    os.tmpdir(),
    `r2-image-${Date.now()}-${randomUUID()}.webp`
  )

  try {
    await runImageWorker(
      inputPath,
      outputPath,
      options
    )

    const outputStat = await stat(outputPath)

    if (!outputStat.isFile() || outputStat.size <= 0) {
      const error = new Error('Image worker produced an empty file')
      error.statusCode = 500
      error.code = 'R2_IMAGE_PROCESSING_FAILED'
      throw error
    }

    return {
      path: outputPath,
      size: outputStat.size,
    }
  } catch (error) {
    await unlink(outputPath).catch(() => {})
    throw error
  }
}

function enqueuePathOptimization(inputPath, options) {
  const job = imageProcessingTail.then(
    () => optimizePathToWebP(inputPath, options),
    () => optimizePathToWebP(inputPath, options)
  )

  imageProcessingTail = job.then(
    () => undefined,
    () => undefined
  )

  return job
}

export async function uploadFileToR2(file, folder = 'uploads') {
  if (!file) return null

  const safeFolder = String(folder || 'uploads')
    .replace(/^\/+|\/+$/g, '')
  const safeExt = getSafeExtension(file)
  const fileName =
    `${safeFolder}/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.${safeExt}`

  const body = file.path
    ? createReadStream(file.path)
    : file.buffer

  if (!body) {
    throw new Error('Upload file data is missing')
  }

  await getR2Client().send(
    new PutObjectCommand({
      Bucket: getR2BucketName(),
      Key: fileName,
      Body: body,
      ContentLength:
        file.path && Number(file.size || 0) > 0
          ? Number(file.size)
          : undefined,
      ContentType: file.mimetype,
      CacheControl:
        'public, max-age=31536000, immutable',
    })
  )

  return `${getR2PublicUrl()}/${fileName}`
}

export async function uploadImageToR2AsWebP(
  file,
  folder = 'uploads',
  options = {}
) {
  if (!file) return null

  const safeFolder = String(folder || 'uploads')
    .replace(/^\/+|\/+$/g, '')
  const fileName =
    `${safeFolder}/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.webp`
  const width = clampInteger(
    options.width,
    320,
    4000,
    1600
  )
  const height = options.height
    ? clampInteger(
        options.height,
        180,
        4000,
        0
      )
    : null
  const quality = clampInteger(
    options.quality,
    40,
    100,
    82
  )
  const minQuality = clampInteger(
    options.minQuality,
    40,
    quality,
    58
  )
  const qualityStep = clampInteger(
    options.qualityStep,
    1,
    20,
    6
  )
  const maxBytes = clampInteger(
    options.maxBytes,
    0,
    20 * 1024 * 1024,
    0
  )
  const fallbackWidth = options.fallbackWidth
    ? clampInteger(
        options.fallbackWidth,
        320,
        width,
        0
      )
    : 0
  const fallbackHeight = options.fallbackHeight
    ? clampInteger(
        options.fallbackHeight,
        180,
        height || 4000,
        0
      )
    : null
  const fit =
    options.fit === 'contain'
      ? 'contain'
      : 'cover'

  if (file.path) {
    const optimized = await enqueuePathOptimization(
      file.path,
      {
        width,
        height,
        quality,
        minQuality,
        qualityStep,
        maxBytes,
        fallbackWidth,
        fallbackHeight,
        fit,
      }
    )

    try {
      await getR2Client().send(
        new PutObjectCommand({
          Bucket: getR2BucketName(),
          Key: fileName,
          Body: createReadStream(optimized.path),
          ContentLength: optimized.size,
          ContentType: 'image/webp',
          CacheControl:
            'public, max-age=31536000, immutable',
        })
      )
    } finally {
      await unlink(optimized.path).catch(() => {})
    }

    return `${getR2PublicUrl()}/${fileName}`
  }

  const qualityLevels = maxBytes > 0
    ? buildQualityLevels(
        quality,
        minQuality,
        qualityStep
      )
    : [quality]
  const profiles = buildResizeProfiles({
    width,
    height,
    fallbackWidth,
    fallbackHeight,
    maxBytes,
  })

  let buffer = null
  let smallestBuffer = null

  for (const profile of profiles) {
    for (const currentQuality of qualityLevels) {
      buffer = await createWebPBuffer(
        file.buffer,
        profile,
        currentQuality,
        fit
      )

      if (
        !smallestBuffer ||
        buffer.length < smallestBuffer.length
      ) {
        smallestBuffer = buffer
      }

      if (
        !maxBytes ||
        buffer.length <= maxBytes
      ) {
        smallestBuffer = buffer
        break
      }
    }

    if (
      !maxBytes ||
      smallestBuffer.length <= maxBytes
    ) {
      break
    }
  }

  if (
    maxBytes &&
    smallestBuffer.length > maxBytes
  ) {
    const error = new Error(
      `Unable to compress image below ${Math.round(
        maxBytes / 1024
      )} KB`
    )
    error.statusCode = 422
    throw error
  }

  await getR2Client().send(
    new PutObjectCommand({
      Bucket: getR2BucketName(),
      Key: fileName,
      Body: smallestBuffer,
      ContentType: 'image/webp',
      CacheControl:
        'public, max-age=31536000, immutable',
    })
  )

  return `${getR2PublicUrl()}/${fileName}`
}

export async function deleteR2ObjectByUrl(fileUrl) {
  const value = String(fileUrl || '').trim()

  if (!value) return false

  const publicPrefix = `${getR2PublicUrl()}/`

  if (!value.startsWith(publicPrefix)) {
    return false
  }

  const key = decodeURIComponent(
    value
      .slice(publicPrefix.length)
      .split('?')[0]
  )

  if (!key) return false

  await getR2Client().send(
    new DeleteObjectCommand({
      Bucket: getR2BucketName(),
      Key: key,
    })
  )

  return true
}
