import dotenv from 'dotenv'
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { supabase } from '../src/config/supabase.js'
import fs from 'node:fs/promises'
import path from 'node:path'

dotenv.config()

const APPLY =
  String(process.env.MIGRATION_APPLY || '')
    .trim()
    .toLowerCase() === 'true'

const REQUIRED_ENV = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_PUBLIC_URL',
]

function requireEnvironment() {
  const missing = REQUIRED_ENV.filter(
    (key) => !String(process.env[key] || '').trim()
  )

  if (missing.length) {
    throw new Error(`Missing environment: ${missing.join(', ')}`)
  }
}

function clean(value) {
  return String(value || '').trim()
}

function normalizeBaseUrl(value) {
  return clean(value).replace(/\/+$/, '')
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseSupabaseStorageUrl(value) {
  const url = clean(value)
  const match = url.match(
    /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/?#]+)\/([^?#]+)/
  )

  if (!match) return null

  return {
    bucket: decodeSafe(match[1]),
    objectPath: decodeSafe(match[2]),
  }
}

function safePart(value, fallback) {
  const result = clean(value)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return result || fallback
}

function extensionFrom({
  objectPath,
  contentType,
}) {
  const fromPath = clean(objectPath)
    .split('?')[0]
    .split('.')
    .pop()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

  if (
    fromPath &&
    fromPath.length <= 6
  ) {
    return fromPath === 'jpeg'
      ? 'jpg'
      : fromPath
  }

  const type = clean(contentType).toLowerCase()

  if (type.includes('webp')) return 'webp'
  if (type.includes('png')) return 'png'
  if (type.includes('gif')) return 'gif'
  if (type.includes('avif')) return 'avif'
  if (type.includes('svg')) return 'svg'
  if (type.includes('jpeg')) return 'jpg'

  return 'jpg'
}

function makeR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint:
      `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  })
}

async function loadSlides() {
  const { data, error } = await supabase
    .from('story_carousel_slides')
    .select('*')
    .order('sort_order', { ascending: true })

  if (error) throw error

  return data || []
}

async function downloadSource(url) {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(
      `Supabase download failed: ${response.status} ${response.statusText}`
    )
  }

  const contentType =
    response.headers.get('content-type') ||
    'application/octet-stream'
  const buffer = Buffer.from(
    await response.arrayBuffer()
  )

  if (
    !contentType.toLowerCase().startsWith('image/') &&
    !clean(url).match(/\.(jpg|jpeg|png|webp|gif|avif|svg)(\?|$)/i)
  ) {
    throw new Error(
      `Source is not an image: ${contentType}`
    )
  }

  if (!buffer.length) {
    throw new Error('Downloaded image is empty')
  }

  return {
    buffer,
    contentType,
    size: buffer.length,
  }
}

async function uploadAndVerify({
  client,
  key,
  image,
}) {
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: image.buffer,
      ContentType: image.contentType,
      CacheControl:
        'public, max-age=31536000, immutable',
    })
  )

  const head = await client.send(
    new HeadObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    })
  )

  const uploadedSize =
    Number(head.ContentLength || 0)

  if (uploadedSize !== image.size) {
    throw new Error(
      `R2 size mismatch: source=${image.size}, r2=${uploadedSize}`
    )
  }

  return {
    size: uploadedSize,
    etag: clean(head.ETag).replace(/^"|"$/g, ''),
    contentType:
      head.ContentType || image.contentType,
  }
}

async function updateSlide({
  slide,
  publicUrl,
}) {
  const patch = {
    image_url: publicUrl,
  }

  if (
    Object.prototype.hasOwnProperty.call(
      slide,
      'updated_at'
    )
  ) {
    patch.updated_at =
      new Date().toISOString()
  }

  const { data, error } = await supabase
    .from('story_carousel_slides')
    .update(patch)
    .eq('id', slide.id)
    .select('*')
    .single()

  if (error) throw error

  return data
}

async function recordR2Asset({
  slide,
  key,
  publicUrl,
  image,
}) {
  try {
    const fileName =
      key.split('/').pop()

    const { error } = await supabase
      .from('r2_assets')
      .insert({
        owner_type: 'story',
        owner_id: slide.story_id || null,
        owner_label: 'Story carousel slide',
        category: 'story_carousel_slide',
        file_name: fileName,
        file_path: key,
        public_url: publicUrl,
        mime_type: image.contentType,
        file_size: image.size,
        uploaded_by: 'migration',
        source_table:
          'story_carousel_slides',
        source_id: slide.id,
        asset_status: 'active',
      })

    if (error) {
      console.warn(
        `R2 asset record warning for ${slide.id}: ${error.message}`
      )
    }
  } catch (error) {
    console.warn(
      `R2 asset record warning for ${slide.id}: ${error.message}`
    )
  }
}

async function deleteSupabaseSource({
  bucket,
  objectPath,
}) {
  const { error } = await supabase.storage
    .from(bucket)
    .remove([objectPath])

  if (error) throw error
}

async function countRemainingSupabaseUrls() {
  const { data, error } = await supabase
    .from('story_carousel_slides')
    .select('id, image_url')

  if (error) throw error

  return (data || []).filter(
    (row) =>
      Boolean(
        parseSupabaseStorageUrl(
          row.image_url
        )
      )
  ).length
}

async function writeReport(report) {
  const outputDir = path.resolve(
    process.cwd(),
    'storage-migration-output'
  )

  await fs.mkdir(
    outputDir,
    { recursive: true }
  )

  const filePath = path.join(
    outputDir,
    'story-carousel-slides-r2.json'
  )

  await fs.writeFile(
    filePath,
    JSON.stringify(report, null, 2),
    'utf8'
  )

  return filePath
}

async function main() {
  requireEnvironment()

  const slides = await loadSlides()
  const candidates = slides
    .map((slide) => ({
      slide,
      source:
        parseSupabaseStorageUrl(
          slide.image_url
        ),
    }))
    .filter((item) => item.source)

  console.log(
    `Mode: ${APPLY ? 'APPLY' : 'CHECK ONLY'}`
  )
  console.log(
    `Supabase story carousel candidates: ${candidates.length}`
  )

  if (!APPLY) {
    candidates.forEach(
      ({ slide, source }, index) => {
        console.log(
          `${index + 1}/${candidates.length} slide=${slide.id} story=${slide.story_id || '-'} source=${source.bucket}/${source.objectPath}`
        )
      }
    )

    console.log(
      '\nNo files were changed.'
    )
    console.log(
      'Run again with MIGRATION_APPLY=true to migrate this group.'
    )
    return
  }

  const client = makeR2Client()
  const publicBaseUrl =
    normalizeBaseUrl(
      process.env.R2_PUBLIC_URL
    )
  const results = []

  for (
    let index = 0;
    index < candidates.length;
    index += 1
  ) {
    const { slide, source } =
      candidates[index]

    const baseLabel =
      `${index + 1}/${candidates.length} slide=${slide.id}`

    try {
      console.log(
        `${baseLabel} downloading...`
      )

      const image = await downloadSource(
        slide.image_url
      )
      const extension =
        extensionFrom({
          objectPath:
            source.objectPath,
          contentType:
            image.contentType,
        })
      const storyId = safePart(
        slide.story_id,
        'unknown-story'
      )
      const slideId = safePart(
        slide.id,
        `slide-${index + 1}`
      )
      const key =
        `story-carousel/${storyId}/${slideId}.${extension}`
      const publicUrl =
        `${publicBaseUrl}/${key}`

      console.log(
        `${baseLabel} uploading to R2...`
      )

      const verified =
        await uploadAndVerify({
          client,
          key,
          image,
        })

      console.log(
        `${baseLabel} updating database...`
      )

      await updateSlide({
        slide,
        publicUrl,
      })

      await recordR2Asset({
        slide,
        key,
        publicUrl,
        image,
      })

      let sourceDeleted = false
      let deleteError = null

      try {
        console.log(
          `${baseLabel} deleting Supabase source...`
        )

        await deleteSupabaseSource(
          source
        )
        sourceDeleted = true
      } catch (error) {
        deleteError =
          error.message
      }

      results.push({
        slide_id: slide.id,
        story_id:
          slide.story_id || null,
        status:
          sourceDeleted
            ? 'MIGRATED_AND_SOURCE_DELETED'
            : 'MIGRATED_SOURCE_DELETE_FAILED',
        old_url:
          slide.image_url,
        new_url:
          publicUrl,
        r2_key: key,
        source_bucket:
          source.bucket,
        source_path:
          source.objectPath,
        source_size:
          image.size,
        r2_size:
          verified.size,
        source_deleted:
          sourceDeleted,
        delete_error:
          deleteError,
      })

      console.log(
        `${baseLabel} done`
      )
    } catch (error) {
      results.push({
        slide_id: slide.id,
        story_id:
          slide.story_id || null,
        status: 'FAILED',
        old_url:
          slide.image_url,
        source_bucket:
          source.bucket,
        source_path:
          source.objectPath,
        error:
          error.message,
      })

      console.error(
        `${baseLabel} failed: ${error.message}`
      )
    }
  }

  const remaining =
    await countRemainingSupabaseUrls()
  const migrated = results.filter(
    (item) =>
      item.status.startsWith(
        'MIGRATED'
      )
  ).length
  const deleted = results.filter(
    (item) =>
      item.source_deleted
  ).length
  const failed = results.filter(
    (item) =>
      item.status === 'FAILED'
  ).length
  const cleanupFailed =
    results.filter(
      (item) =>
        item.status ===
        'MIGRATED_SOURCE_DELETE_FAILED'
    ).length

  const report = {
    generated_at:
      new Date().toISOString(),
    table:
      'story_carousel_slides',
    initial_candidates:
      candidates.length,
    migrated,
    supabase_sources_deleted:
      deleted,
    source_delete_failed:
      cleanupFailed,
    failed,
    remaining_supabase_urls:
      remaining,
    success:
      failed === 0 &&
      cleanupFailed === 0 &&
      remaining === 0,
    results,
  }

  const reportPath =
    await writeReport(report)

  console.log(
    '\nSTORY CAROUSEL MIGRATION COMPLETE\n'
  )
  console.log(
    JSON.stringify(
      {
        initial_candidates:
          report.initial_candidates,
        migrated:
          report.migrated,
        supabase_sources_deleted:
          report.supabase_sources_deleted,
        source_delete_failed:
          report.source_delete_failed,
        failed:
          report.failed,
        remaining_supabase_urls:
          report.remaining_supabase_urls,
        success:
          report.success,
        report:
          reportPath,
      },
      null,
      2
    )
  )

  if (!report.success) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(
    '\nSTORY CAROUSEL MIGRATION FAILED\n'
  )
  console.error(error)
  process.exit(1)
})
