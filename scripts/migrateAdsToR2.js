import dotenv from 'dotenv'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { supabase } from '../src/config/supabase.js'

dotenv.config()

const requiredEnv = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_PUBLIC_URL',
]

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing ${key}`)
  }
}

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

function isSupabaseStorageUrl(url) {
  return typeof url === 'string' && url.includes('/storage/v1/object/public/')
}

function normalizePublicBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '')
}

function getExtensionFromContentType(contentType) {
  if (!contentType) return 'jpg'
  if (contentType.includes('webp')) return 'webp'
  if (contentType.includes('png')) return 'png'
  if (contentType.includes('gif')) return 'gif'
  if (contentType.includes('jpeg')) return 'jpg'
  if (contentType.includes('jpg')) return 'jpg'
  return 'jpg'
}

async function downloadImage(url) {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`)
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg'
  const buffer = Buffer.from(await response.arrayBuffer())

  return {
    buffer,
    contentType,
    size: buffer.length,
  }
}

async function uploadToR2({ objectKey, image }) {
  await r2.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: objectKey,
    Body: image.buffer,
    ContentType: image.contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }))
}

async function recordAsset({
  category,
  fileName,
  filePath,
  publicUrl,
  mimeType,
  fileSize,
}) {
  const { error } = await supabase
    .from('r2_assets')
    .insert({
      owner_type: 'admin',
      owner_id: null,
      owner_label: 'Advertisement',
      category,
      file_name: fileName,
      file_path: filePath,
      public_url: publicUrl,
      mime_type: mimeType,
      file_size: fileSize,
      uploaded_by: 'migration',
      source_table: 'shadow_advertisements',
      source_id: null,
      asset_status: 'active',
    })

  if (error) throw error
}

async function migrateAdsToR2() {
  const publicBaseUrl = normalizePublicBaseUrl(process.env.R2_PUBLIC_URL)

  const { data: ads, error } = await supabase
    .from('shadow_advertisements')
    .select('placement, image_url')
    .not('image_url', 'is', null)

  if (error) throw error

  let migrated = 0
  let skipped = 0
  let failed = 0

  for (const ad of ads || []) {
    try {
      if (!isSupabaseStorageUrl(ad.image_url)) {
        skipped += 1
        continue
      }

      const image = await downloadImage(ad.image_url)
      const ext = getExtensionFromContentType(image.contentType)
      const fileName = `${ad.placement}-migrated.${ext}`
      const filePath = `ads/${ad.placement}/${fileName}`
      const publicUrl = `${publicBaseUrl}/${filePath}`

      await uploadToR2({ objectKey: filePath, image })

      const { error: updateError } = await supabase
        .from('shadow_advertisements')
        .update({
          image_url: publicUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('placement', ad.placement)

      if (updateError) throw updateError

      await recordAsset({
        category: 'ads',
        fileName,
        filePath,
        publicUrl,
        mimeType: image.contentType,
        fileSize: image.size,
      })

      migrated += 1
      console.log(`MIGRATED shadow_advertisements.image_url ${ad.placement} ${image.size} bytes`)
    } catch (error) {
      failed += 1
      console.error(`FAILED shadow_advertisements.image_url ${ad.placement}: ${error.message}`)
    }
  }

  console.log(JSON.stringify({
    migrated,
    skipped,
    failed,
  }, null, 2))

  if (failed > 0) {
    process.exitCode = 1
  }
}

migrateAdsToR2().catch((error) => {
  console.error(error)
  process.exit(1)
})
