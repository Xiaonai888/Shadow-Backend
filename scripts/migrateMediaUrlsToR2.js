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
  ownerType,
  ownerId,
  ownerLabel,
  category,
  fileName,
  filePath,
  publicUrl,
  mimeType,
  fileSize,
  uploadedBy,
  sourceTable,
  sourceId,
}) {
  const { error } = await supabase
    .from('r2_assets')
    .insert({
      owner_type: ownerType,
      owner_id: ownerId,
      owner_label: ownerLabel,
      category,
      file_name: fileName,
      file_path: filePath,
      public_url: publicUrl,
      mime_type: mimeType,
      file_size: fileSize,
      uploaded_by: uploadedBy,
      source_table: sourceTable,
      source_id: sourceId,
      asset_status: 'active',
    })

  if (error) throw error
}

async function migrateStoryCovers(publicBaseUrl) {
  const { data: stories, error } = await supabase
    .from('stories')
    .select('id, author_id, user_id, title, cover_url')
    .not('cover_url', 'is', null)

  if (error) throw error

  let migrated = 0
  let skipped = 0
  let failed = 0

  for (const story of stories || []) {
    try {
      if (!isSupabaseStorageUrl(story.cover_url)) {
        skipped += 1
        continue
      }

      const image = await downloadImage(story.cover_url)
      const ext = getExtensionFromContentType(image.contentType)
      const fileName = `cover-migrated-${story.id}.${ext}`
      const filePath = `covers/stories/${story.id}/${fileName}`
      const publicUrl = `${publicBaseUrl}/${filePath}`

      await uploadToR2({ objectKey: filePath, image })

      const { error: updateError } = await supabase
        .from('stories')
        .update({
          cover_url: publicUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('id', story.id)

      if (updateError) throw updateError

      await recordAsset({
        ownerType: story.author_id ? 'author' : 'admin',
        ownerId: story.author_id || null,
        ownerLabel: story.title || null,
        category: 'story_cover',
        fileName,
        filePath,
        publicUrl,
        mimeType: image.contentType,
        fileSize: image.size,
        uploadedBy: story.user_id || null,
        sourceTable: 'stories',
        sourceId: story.id,
      })

      migrated += 1
      console.log(`MIGRATED stories.cover_url ${story.id} ${image.size} bytes`)
    } catch (error) {
      failed += 1
      console.error(`FAILED stories.cover_url ${story.id}: ${error.message}`)
    }
  }

  return { migrated, skipped, failed }
}

async function migrateAuthorImage({ page, fieldName, category, folder, publicBaseUrl }) {
  const oldUrl = page[fieldName]

  if (!isSupabaseStorageUrl(oldUrl)) {
    return 'skipped'
  }

  const image = await downloadImage(oldUrl)
  const ext = getExtensionFromContentType(image.contentType)
  const fileName = `${fieldName.replace('_url', '')}-migrated-${page.id}.${ext}`
  const filePath = `authors/${page.id}/${folder}/${fileName}`
  const publicUrl = `${publicBaseUrl}/${filePath}`

  await uploadToR2({ objectKey: filePath, image })

  const { error: updateError } = await supabase
    .from('author_pages')
    .update({
      [fieldName]: publicUrl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', page.id)

  if (updateError) throw updateError

  await recordAsset({
    ownerType: 'author',
    ownerId: page.id,
    ownerLabel: page.page_name || page.page_username || null,
    category,
    fileName,
    filePath,
    publicUrl,
    mimeType: image.contentType,
    fileSize: image.size,
    uploadedBy: page.user_id || null,
    sourceTable: 'author_pages',
    sourceId: page.id,
  })

  console.log(`MIGRATED author_pages.${fieldName} ${page.id} ${image.size} bytes`)
  return 'migrated'
}

async function migrateAuthorProfileImages(publicBaseUrl) {
  const { data: pages, error } = await supabase
    .from('author_pages')
    .select('id, user_id, page_name, page_username, avatar_url, cover_url')

  if (error) throw error

  const result = {
    migrated: 0,
    skipped: 0,
    failed: 0,
  }

  for (const page of pages || []) {
    for (const item of [
      { fieldName: 'avatar_url', category: 'author_avatar', folder: 'avatars' },
      { fieldName: 'cover_url', category: 'author_cover', folder: 'covers' },
    ]) {
      try {
        const status = await migrateAuthorImage({
          page,
          ...item,
          publicBaseUrl,
        })

        result[status] += 1
      } catch (error) {
        result.failed += 1
        console.error(`FAILED author_pages.${item.fieldName} ${page.id}: ${error.message}`)
      }
    }
  }

  return result
}

async function migrateMediaUrlsToR2() {
  const publicBaseUrl = normalizePublicBaseUrl(process.env.R2_PUBLIC_URL)

  const stories = await migrateStoryCovers(publicBaseUrl)
  const authors = await migrateAuthorProfileImages(publicBaseUrl)

  const total = {
    migrated: stories.migrated + authors.migrated,
    skipped: stories.skipped + authors.skipped,
    failed: stories.failed + authors.failed,
  }

  console.log(JSON.stringify({
    stories,
    authors,
    total,
  }, null, 2))

  if (total.failed > 0) {
    process.exitCode = 1
  }
}

migrateMediaUrlsToR2().catch((error) => {
  console.error(error)
  process.exit(1)
})
