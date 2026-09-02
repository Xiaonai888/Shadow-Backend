import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { evaluateHeavyJobAdmission } from './memoryGuard.service.js'

const WORKER_TIMEOUT_MS = 3 * 60 * 1000
const ADMISSION_TIMEOUT_MS = 5 * 60 * 1000
const ADMISSION_POLL_MS = 1000
const ESTIMATED_WORKER_MB = 140

let client = null
let processingTail = Promise.resolve()

function env(...names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim()
    if (value) return value
  }

  return ''
}

function configuration() {
  const accountId = env('R2_ACCOUNT_ID')
  const endpoint =
    env('CLOUDFLARE_R2_ENDPOINT') ||
    (accountId
      ? `https://${accountId}.r2.cloudflarestorage.com`
      : '')
  const accessKeyId = env(
    'CLOUDFLARE_R2_ACCESS_KEY_ID',
    'R2_ACCESS_KEY_ID'
  )
  const secretAccessKey = env(
    'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
    'R2_SECRET_ACCESS_KEY'
  )
  const bucket = env(
    'CLOUDFLARE_R2_BUCKET',
    'R2_BUCKET_NAME'
  )
  const publicUrl = env(
    'CLOUDFLARE_R2_PUBLIC_URL',
    'R2_PUBLIC_URL'
  ).replace(/\/+$/, '')

  if (
    !endpoint ||
    !accessKeyId ||
    !secretAccessKey ||
    !bucket ||
    !publicUrl
  ) {
    throw new Error('Cloudflare R2 is not configured')
  }

  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicUrl,
  }
}

function r2() {
  if (client) return client

  const config = configuration()

  client = new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })

  return client
}

function safeSegment(value, fallback = 'media') {
  const output = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)

  return output || fallback
}

function uniqueKeys(values) {
  return [
    ...new Set(
      (values || [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForWorkerAdmission() {
  const startedAt = Date.now()
  let lastAdmission = null

  while (Date.now() - startedAt < ADMISSION_TIMEOUT_MS) {
    lastAdmission = evaluateHeavyJobAdmission({
      jobType: 'media_library_image',
      estimatedJobMb: ESTIMATED_WORKER_MB,
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
  error.code = 'MEDIA_LIBRARY_PROCESSING_BUSY'
  error.admission = lastAdmission
  throw error
}

function workerPath() {
  return new URL(
    '../workers/mediaLibraryImage.worker.js',
    import.meta.url
  )
}

function runWorker(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        workerPath().pathname,
        inputPath,
        outputPath,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )

    let stderr = ''
    let settled = false

    const finish = (error = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '')
      if (stderr.length > 4000) {
        stderr = stderr.slice(-4000)
      }
    })

    child.once('error', (error) => {
      finish(error)
    })

    child.once('exit', (code, signal) => {
      if (code === 0) {
        finish()
        return
      }

      const error = new Error(
        stderr.trim() ||
          `Image worker exited with code ${code ?? 'unknown'}${
            signal ? ` (${signal})` : ''
          }`
      )
      error.statusCode = 500
      error.code = 'MEDIA_LIBRARY_IMAGE_PROCESSING_FAILED'
      finish(error)
    })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      const error = new Error('Image processing timed out')
      error.statusCode = 503
      error.code = 'MEDIA_LIBRARY_IMAGE_PROCESSING_TIMEOUT'
      finish(error)
    }, WORKER_TIMEOUT_MS)

    timer.unref?.()
  })
}

async function optimizeToTempFile(inputPath) {
  await waitForWorkerAdmission()

  const outputPath = path.join(
    os.tmpdir(),
    `media-library-${Date.now()}-${randomUUID()}.webp`
  )

  try {
    await runWorker(inputPath, outputPath)
    const fileStat = await stat(outputPath)

    if (!fileStat.isFile() || fileStat.size <= 0) {
      throw new Error('Image worker produced an empty file')
    }

    return {
      outputPath,
      size: fileStat.size,
    }
  } catch (error) {
    await unlink(outputPath).catch(() => {})
    throw error
  }
}

function enqueueOptimization(inputPath) {
  const job = processingTail.then(
    () => optimizeToTempFile(inputPath),
    () => optimizeToTempFile(inputPath)
  )

  processingTail = job.then(
    () => undefined,
    () => undefined
  )

  return job
}

export async function uploadMediaLibraryObject({
  file,
  prefix = 'media-library/images',
}) {
  if (!file?.path) {
    throw new Error('Temporary image file is required')
  }

  if (!String(file.mimetype || '').startsWith('image/')) {
    throw new Error('Only image files are allowed')
  }

  const config = configuration()
  const optimized = await enqueueOptimization(file.path)
  const key =
    `${String(prefix || 'media-library/images')
      .replace(/^\/+|\/+$/g, '')}/` +
    `${Date.now()}-${randomUUID()}.webp`

  try {
    await r2().send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: createReadStream(optimized.outputPath),
        ContentLength: optimized.size,
        ContentType: 'image/webp',
        CacheControl:
          'public, max-age=31536000, immutable',
      })
    )

    const head = await r2().send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: key,
      })
    )

    const uploadedSize = Number(
      head.ContentLength || 0
    )

    if (uploadedSize !== optimized.size) {
      await deleteMediaLibraryObject(key).catch(() => {})
      throw new Error(
        'Cloudflare R2 upload verification failed'
      )
    }

    return {
      storage_key: key,
      image_url: `${config.publicUrl}/${key}`,
      file_size: uploadedSize,
      source_file_size: Number(file.size || 0),
      mime_type: 'image/webp',
    }
  } finally {
    await unlink(optimized.outputPath).catch(() => {})
  }
}

export async function deleteMediaLibraryObject(
  storageKey
) {
  const key = String(storageKey || '').trim()

  if (!key) return false

  const config = configuration()

  await r2().send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: key,
    })
  )

  return true
}

export async function deleteMediaLibraryObjects(
  storageKeys
) {
  const keys = uniqueKeys(storageKeys)

  if (!keys.length) {
    return { deleted: 0 }
  }

  const config = configuration()
  let deleted = 0

  for (
    let index = 0;
    index < keys.length;
    index += 1000
  ) {
    const batch = keys.slice(
      index,
      index + 1000
    )

    await r2().send(
      new DeleteObjectsCommand({
        Bucket: config.bucket,
        Delete: {
          Quiet: true,
          Objects: batch.map((Key) => ({
            Key,
          })),
        },
      })
    )

    deleted += batch.length
  }

  return { deleted }
}

export function mediaLibraryFolderPrefix(
  folderId
) {
  return `media-library/folders/${safeSegment(
    folderId,
    'folder'
  )}`
}
