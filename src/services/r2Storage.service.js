import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import sharp from 'sharp'

let r2Client = null

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
      height: fallbackHeight || (height ? Math.round((fallbackWidth * height) / width) : null),
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
        (item) => item.width === profile.width && item.height === profile.height
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

export async function uploadFileToR2(file, folder = 'uploads') {
  if (!file) return null

  const safeFolder = String(folder || 'uploads').replace(/^\/+|\/+$/g, '')
  const safeExt = getSafeExtension(file)
  const fileName = `${safeFolder}/${Date.now()}-${Math.random().toString(36).slice(2)}.${safeExt}`

  await getR2Client().send(new PutObjectCommand({
    Bucket: getR2BucketName(),
    Key: fileName,
    Body: file.buffer,
    ContentType: file.mimetype,
    CacheControl: 'public, max-age=31536000, immutable',
  }))

  return `${getR2PublicUrl()}/${fileName}`
}

export async function uploadImageToR2AsWebP(file, folder = 'uploads', options = {}) {
  if (!file) return null

  const safeFolder = String(folder || 'uploads').replace(/^\/+|\/+$/g, '')
  const fileName = `${safeFolder}/${Date.now()}-${Math.random().toString(36).slice(2)}.webp`
  const width = clampInteger(options.width, 320, 4000, 1600)
  const height = options.height
    ? clampInteger(options.height, 180, 4000, 0)
    : null
  const quality = clampInteger(options.quality, 40, 100, 82)
  const minQuality = clampInteger(options.minQuality, 40, quality, 58)
  const qualityStep = clampInteger(options.qualityStep, 1, 20, 6)
  const maxBytes = clampInteger(options.maxBytes, 0, 20 * 1024 * 1024, 0)
  const fallbackWidth = options.fallbackWidth
    ? clampInteger(options.fallbackWidth, 320, width, 0)
    : 0
  const fallbackHeight = options.fallbackHeight
    ? clampInteger(options.fallbackHeight, 180, height || 4000, 0)
    : null
  const fit = options.fit === 'contain' ? 'contain' : 'cover'
  const qualityLevels = maxBytes > 0
    ? buildQualityLevels(quality, minQuality, qualityStep)
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

      if (!smallestBuffer || buffer.length < smallestBuffer.length) {
        smallestBuffer = buffer
      }

      if (!maxBytes || buffer.length <= maxBytes) {
        smallestBuffer = buffer
        break
      }
    }

    if (!maxBytes || smallestBuffer.length <= maxBytes) break
  }

  if (maxBytes && smallestBuffer.length > maxBytes) {
    const error = new Error(
      `Unable to compress image below ${Math.round(maxBytes / 1024)} KB`
    )
    error.statusCode = 422
    throw error
  }

  await getR2Client().send(new PutObjectCommand({
    Bucket: getR2BucketName(),
    Key: fileName,
    Body: smallestBuffer,
    ContentType: 'image/webp',
    CacheControl: 'public, max-age=31536000, immutable',
  }))

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
