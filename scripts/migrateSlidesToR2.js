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

function safeName(value) {
  return String(value || 'slide')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'slide'
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

async function migrateSlides() {
  const { data: slides, error } = await supabase
    .from('slides')
    .select('id, section_key, title, image_url')
    .not('image_url', 'is', null)
    .order('section_key', { ascending: true })

  if (error) throw error

  const publicBaseUrl = normalizePublicBaseUrl(process.env.R2_PUBLIC_URL)
  let migrated = 0
  let skipped = 0
  let failed = 0

  for (const slide of slides || []) {
    try {
      if (!isSupabaseStorageUrl(slide.image_url)) {
        skipped += 1
        console.log(`SKIP ${slide.id}`)
        continue
      }

      const image = await downloadImage(slide.image_url)
      const ext = getExtensionFromContentType(image.contentType)
      const sectionKey = safeName(slide.section_key)
      const title = safeName(slide.title)
      const objectKey = `slides/${sectionKey}/${slide.id}-${title}.${ext}`
      const publicUrl = `${publicBaseUrl}/${objectKey}`

      await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: objectKey,
        Body: image.buffer,
        ContentType: image.contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }))

      const { error: updateError } = await supabase
        .from('slides')
        .update({
          image_url: publicUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('id', slide.id)

      if (updateError) throw updateError

      migrated += 1
      console.log(`MIGRATED ${slide.id} ${image.size} bytes`)
    } catch (error) {
      failed += 1
      console.error(`FAILED ${slide.id}: ${error.message}`)
    }
  }

  console.log(JSON.stringify({ migrated, skipped, failed }, null, 2))

  if (failed > 0) {
    process.exitCode = 1
  }
}

migrateSlides().catch((error) => {
  console.error(error)
  process.exit(1)
})
