import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
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
  const width = Number(options.width || 1600)
  const quality = Number(options.quality || 82)

  const buffer = await sharp(file.buffer)
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .webp({ quality })
    .toBuffer()

  await getR2Client().send(new PutObjectCommand({
    Bucket: getR2BucketName(),
    Key: fileName,
    Body: buffer,
    ContentType: 'image/webp',
    CacheControl: 'public, max-age=31536000, immutable',
  }))

  return `${getR2PublicUrl()}/${fileName}`
}
