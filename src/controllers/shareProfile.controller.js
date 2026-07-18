import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import sharp from 'sharp'

const CUSTOM_IMAGE_TTL_MS = 24 * 60 * 60 * 1000
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
  const bucketName = String(process.env.R2_BUCKET_NAME || '').trim()

  if (!bucketName) throw new Error('Missing R2_BUCKET_NAME')

  return bucketName
}

function getR2PublicUrl() {
  const publicUrl = String(process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '')

  if (!publicUrl) throw new Error('Missing R2_PUBLIC_URL')

  return publicUrl
}

function getSafeUserId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '')
}

function getCustomImageKey(userId) {
  return `share-profile-temp/${getSafeUserId(userId)}.webp`
}

export async function uploadShareProfileCustomImage(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        message: 'Image file is required. Use form field name: image',
      })
    }

    if (!req.file.mimetype?.startsWith('image/')) {
      return res.status(400).json({
        ok: false,
        message: 'Only image files are allowed',
      })
    }

    const imageBuffer = await sharp(req.file.buffer)
      .rotate()
      .resize({
        width: 1080,
        height: 1920,
        fit: 'cover',
        position: 'centre',
        withoutEnlargement: false,
      })
      .webp({
        quality: 82,
        effort: 4,
        smartSubsample: true,
      })
      .toBuffer()

    const key = getCustomImageKey(userId)
    const expiresAt = new Date(Date.now() + CUSTOM_IMAGE_TTL_MS).toISOString()

    await getR2Client().send(
      new PutObjectCommand({
        Bucket: getR2BucketName(),
        Key: key,
        Body: imageBuffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=300, must-revalidate',
        ContentDisposition: 'inline',
        Metadata: {
          expiresat: expiresAt,
          userid: String(userId),
        },
      })
    )

    const imageUrl = `${getR2PublicUrl()}/${key}?v=${Date.now()}`

    return res.status(201).json({
      ok: true,
      image_url: imageUrl,
      imageUrl,
      expires_at: expiresAt,
      expiresAt,
      lifetime_hours: 24,
    })
  } catch (error) {
    console.error('UPLOAD SHARE PROFILE IMAGE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to upload custom background',
    })
  }
}

export async function deleteShareProfileCustomImage(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    await getR2Client().send(
      new DeleteObjectCommand({
        Bucket: getR2BucketName(),
        Key: getCustomImageKey(userId),
      })
    )

    return res.status(200).json({
      ok: true,
      message: 'Custom background deleted',
    })
  } catch (error) {
    console.error('DELETE SHARE PROFILE IMAGE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to delete custom background',
    })
  }
}
