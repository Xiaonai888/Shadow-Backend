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

function parseGallery(value) {
  if (Array.isArray(value)) return value.filter(Boolean)

  if (!value) return []

  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.filter(Boolean)
  } catch {}

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
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
  sourceTable,
  sourceId,
  ownerLabel,
}) {
  const { error } = await supabase
    .from('r2_assets')
    .insert({
      owner_type: 'admin',
      owner_id: null,
      owner_label: ownerLabel || null,
      category,
      file_name: fileName,
      file_path: filePath,
      public_url: publicUrl,
      mime_type: mimeType,
      file_size: fileSize,
      uploaded_by: 'migration',
      source_table: sourceTable,
      source_id: sourceId,
      asset_status: 'active',
    })

  if (error) throw error
}

async function migrateProductCover(product, publicBaseUrl) {
  if (!isSupabaseStorageUrl(product.cover_url)) return 'skipped'

  const image = await downloadImage(product.cover_url)
  const ext = getExtensionFromContentType(image.contentType)
  const fileName = `cover-migrated-${product.id}.${ext}`
  const filePath = `shadow-mall/covers/${product.id}/${fileName}`
  const publicUrl = `${publicBaseUrl}/${filePath}`

  await uploadToR2({ objectKey: filePath, image })

  const { error } = await supabase
    .from('shadow_mall_products')
    .update({
      cover_url: publicUrl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', product.id)

  if (error) throw error

  await recordAsset({
    category: 'shadow_mall_cover',
    fileName,
    filePath,
    publicUrl,
    mimeType: image.contentType,
    fileSize: image.size,
    sourceTable: 'shadow_mall_products',
    sourceId: product.id,
    ownerLabel: product.title || null,
  })

  console.log(`MIGRATED shadow_mall_products.cover_url ${product.id} ${image.size} bytes`)
  return 'migrated'
}

async function migrateProductGallery(product, publicBaseUrl) {
  const gallery = parseGallery(product.gallery_image_urls)

  if (!gallery.some(isSupabaseStorageUrl)) return 'skipped'

  const nextGallery = []
  let migratedCount = 0

  for (let index = 0; index < gallery.length; index += 1) {
    const url = gallery[index]

    if (!isSupabaseStorageUrl(url)) {
      nextGallery.push(url)
      continue
    }

    const image = await downloadImage(url)
    const ext = getExtensionFromContentType(image.contentType)
    const fileName = `gallery-${index + 1}-migrated-${product.id}.${ext}`
    const filePath = `shadow-mall/gallery/${product.id}/${fileName}`
    const publicUrl = `${publicBaseUrl}/${filePath}`

    await uploadToR2({ objectKey: filePath, image })

    await recordAsset({
      category: 'shadow_mall_gallery',
      fileName,
      filePath,
      publicUrl,
      mimeType: image.contentType,
      fileSize: image.size,
      sourceTable: 'shadow_mall_products',
      sourceId: product.id,
      ownerLabel: product.title || null,
    })

    nextGallery.push(publicUrl)
    migratedCount += 1
    console.log(`MIGRATED shadow_mall_products.gallery_image_urls ${product.id} #${index + 1} ${image.size} bytes`)
  }

  const { error } = await supabase
    .from('shadow_mall_products')
    .update({
      gallery_image_urls: nextGallery,
      updated_at: new Date().toISOString(),
    })
    .eq('id', product.id)

  if (error) throw error

  return migratedCount > 0 ? 'migrated' : 'skipped'
}

async function migratePublisherLogo(publisher, publicBaseUrl) {
  if (!isSupabaseStorageUrl(publisher.logo_url)) return 'skipped'

  const image = await downloadImage(publisher.logo_url)
  const ext = getExtensionFromContentType(image.contentType)
  const fileName = `publisher-logo-migrated-${publisher.id}.${ext}`
  const filePath = `shadow-mall/publishers/${publisher.id}/${fileName}`
  const publicUrl = `${publicBaseUrl}/${filePath}`

  await uploadToR2({ objectKey: filePath, image })

  const { error } = await supabase
    .from('shadow_mall_publishers')
    .update({
      logo_url: publicUrl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', publisher.id)

  if (error) throw error

  await recordAsset({
    category: 'shadow_mall_publisher_logo',
    fileName,
    filePath,
    publicUrl,
    mimeType: image.contentType,
    fileSize: image.size,
    sourceTable: 'shadow_mall_publishers',
    sourceId: null,
    ownerLabel: publisher.name || null,
  })

  console.log(`MIGRATED shadow_mall_publishers.logo_url ${publisher.id} ${image.size} bytes`)
  return 'migrated'
}

async function migrateShadowMallToR2() {
  const publicBaseUrl = normalizePublicBaseUrl(process.env.R2_PUBLIC_URL)

  const { data: products, error: productsError } = await supabase
    .from('shadow_mall_products')
    .select('id, title, cover_url, gallery_image_urls')

  if (productsError) throw productsError

  const { data: publishers, error: publishersError } = await supabase
    .from('shadow_mall_publishers')
    .select('id, name, logo_url')

  if (publishersError) throw publishersError

  const result = {
    product_covers: { migrated: 0, skipped: 0, failed: 0 },
    product_gallery_rows: { migrated: 0, skipped: 0, failed: 0 },
    publisher_logos: { migrated: 0, skipped: 0, failed: 0 },
  }

  for (const product of products || []) {
    try {
      const status = await migrateProductCover(product, publicBaseUrl)
      result.product_covers[status] += 1
    } catch (error) {
      result.product_covers.failed += 1
      console.error(`FAILED shadow_mall_products.cover_url ${product.id}: ${error.message}`)
    }

    try {
      const status = await migrateProductGallery(product, publicBaseUrl)
      result.product_gallery_rows[status] += 1
    } catch (error) {
      result.product_gallery_rows.failed += 1
      console.error(`FAILED shadow_mall_products.gallery_image_urls ${product.id}: ${error.message}`)
    }
  }

  for (const publisher of publishers || []) {
    try {
      const status = await migratePublisherLogo(publisher, publicBaseUrl)
      result.publisher_logos[status] += 1
    } catch (error) {
      result.publisher_logos.failed += 1
      console.error(`FAILED shadow_mall_publishers.logo_url ${publisher.id}: ${error.message}`)
    }
  }

  const total = {
    migrated:
      result.product_covers.migrated +
      result.product_gallery_rows.migrated +
      result.publisher_logos.migrated,
    skipped:
      result.product_covers.skipped +
      result.product_gallery_rows.skipped +
      result.publisher_logos.skipped,
    failed:
      result.product_covers.failed +
      result.product_gallery_rows.failed +
      result.publisher_logos.failed,
  }

  console.log(JSON.stringify({
    ...result,
    total,
  }, null, 2))

  if (total.failed > 0) {
    process.exitCode = 1
  }
}

migrateShadowMallToR2().catch((error) => {
  console.error(error)
  process.exit(1)
})
