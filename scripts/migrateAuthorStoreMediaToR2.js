import crypto from 'node:crypto'
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { supabase } from '../src/config/supabase.js'

const APPLY_CONFIRM_VALUE = 'MIGRATE_AUTHOR_STORE_MEDIA_TO_R2'
const PAGE_SIZE = 500

function clean(value) {
  return String(value ?? '').trim()
}

function env(...names) {
  for (const name of names) {
    const value = clean(process.env[name])
    if (value) return value
  }

  return ''
}

const config = {
  mode: clean(process.env.MIGRATION_MODE || 'dry-run').toLowerCase(),
  accountId: env('R2_ACCOUNT_ID'),
  accessKeyId: env('R2_ACCESS_KEY_ID'),
  secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
  bucket: env('R2_BUCKET_NAME'),
  publicUrl: env('R2_PUBLIC_URL').replace(/\/+$/, ''),
}

function isApplyMode() {
  return config.mode === 'apply'
}

function requireConfig() {
  const missing = []

  if (!config.accountId) missing.push('R2_ACCOUNT_ID')
  if (!config.accessKeyId) missing.push('R2_ACCESS_KEY_ID')
  if (!config.secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY')
  if (!config.bucket) missing.push('R2_BUCKET_NAME')
  if (!config.publicUrl) missing.push('R2_PUBLIC_URL')

  if (missing.length) {
    throw new Error(`Missing environment: ${missing.join(', ')}`)
  }

  if (
    isApplyMode() &&
    clean(process.env.MIGRATION_CONFIRM) !== APPLY_CONFIRM_VALUE
  ) {
    throw new Error(
      `Apply mode requires MIGRATION_CONFIRM=${APPLY_CONFIRM_VALUE}`
    )
  }
}

function makeR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
}

function isR2Url(value) {
  const url = clean(value)
  return Boolean(url && config.publicUrl && url.startsWith(`${config.publicUrl}/`))
}

function isSupabaseStorageUrl(value) {
  const url = clean(value).toLowerCase()

  return (
    url.includes('supabase.co') &&
    (
      url.includes('/storage/v1/object/') ||
      url.includes('/storage/v1/render/image/')
    )
  )
}

function safePart(value, fallback = 'file') {
  const result = clean(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)

  return result || fallback
}

function extensionFromContentType(value) {
  const type = clean(value).toLowerCase().split(';')[0]

  if (type === 'image/webp') return 'webp'
  if (type === 'image/png') return 'png'
  if (type === 'image/gif') return 'gif'
  if (type === 'image/avif') return 'avif'
  return 'jpg'
}

function galleryUrl(item) {
  if (typeof item === 'string') return clean(item)

  return clean(
    item?.url ||
    item?.image_url ||
    item?.imageUrl
  )
}

function replaceGalleryUrl(item, url) {
  if (typeof item === 'string') return url

  const next = {
    ...(item && typeof item === 'object' ? item : {}),
  }

  if ('url' in next) next.url = url
  else if ('image_url' in next) next.image_url = url
  else if ('imageUrl' in next) next.imageUrl = url
  else next.url = url

  return next
}

function hash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
}

async function readAllProducts() {
  const rows = []
  let from = 0

  while (true) {
    const { data, error } = await supabase
      .from('author_store_products')
      .select(
        'id, author_page_id, cover_url, gallery_images, updated_at'
      )
      .range(from, from + PAGE_SIZE - 1)

    if (error) throw error

    const page = data || []
    rows.push(...page)

    if (page.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return rows
}

async function readAuthorPages(authorPageIds) {
  if (!authorPageIds.length) return new Map()

  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id, page_name, page_username')
    .in('id', authorPageIds)

  if (error) throw error

  return new Map(
    (data || []).map((page) => [String(page.id), page])
  )
}

async function downloadImage(url) {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(
      `Download failed ${response.status}: ${url}`
    )
  }

  const contentType = clean(
    response.headers.get('content-type') || 'image/jpeg'
  )

  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(
      `Expected image but received ${contentType || 'unknown content type'}`
    )
  }

  const buffer = Buffer.from(await response.arrayBuffer())

  if (!buffer.length) {
    throw new Error('Downloaded image is empty')
  }

  return {
    buffer,
    contentType,
    size: buffer.length,
  }
}

async function verifyR2Object(r2, key, size) {
  const head = await r2.send(
    new HeadObjectCommand({
      Bucket: config.bucket,
      Key: key,
    })
  )

  const storedSize = Number(head.ContentLength || 0)

  if (storedSize !== Number(size || 0)) {
    throw new Error(
      `R2 verification failed for ${key}: ${storedSize} != ${size}`
    )
  }
}

async function recordAssetIfMissing({
  authorPage,
  category,
  fileName,
  filePath,
  publicUrl,
  image,
  productId,
}) {
  const { data: existing, error: readError } = await supabase
    .from('r2_assets')
    .select('id')
    .eq('public_url', publicUrl)
    .limit(1)

  if (readError) throw readError
  if ((existing || []).length) return

  const { error } = await supabase
    .from('r2_assets')
    .insert({
      owner_type: 'author',
      owner_id: authorPage.id,
      owner_label:
        authorPage.page_name ||
        authorPage.page_username ||
        null,
      category,
      file_name: fileName,
      file_path: filePath,
      public_url: publicUrl,
      mime_type: image.contentType,
      file_size: image.size,
      uploaded_by: authorPage.user_id || null,
      source_table: 'author_store_products',
      source_id: productId,
      asset_status: 'active',
    })

  if (error) throw error
}

async function migrateImage({
  r2,
  url,
  authorPage,
  productId,
  category,
  index = null,
}) {
  const currentUrl = clean(url)

  if (!currentUrl) {
    return {
      status: 'empty',
      url: currentUrl,
    }
  }

  if (isR2Url(currentUrl)) {
    return {
      status: 'r2',
      url: currentUrl,
    }
  }

  if (!isSupabaseStorageUrl(currentUrl)) {
    return {
      status: 'external',
      url: currentUrl,
    }
  }

  if (!isApplyMode()) {
    return {
      status: 'pending',
      url: currentUrl,
    }
  }

  const image = await downloadImage(currentUrl)
  const ext = extensionFromContentType(image.contentType)
  const mediaType = category === 'author_store_cover' ? 'covers' : 'gallery'
  const suffix = index === null ? 'cover' : `gallery-${index + 1}`
  const fileName =
    `migrated-${safePart(productId)}-${suffix}-${hash(currentUrl).slice(0, 10)}.${ext}`
  const filePath =
    `author-store/${mediaType}/${safePart(authorPage.id)}/${fileName}`
  const publicUrl = `${config.publicUrl}/${filePath}`

  await r2.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: filePath,
      Body: image.buffer,
      ContentLength: image.size,
      ContentType: image.contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    })
  )

  await verifyR2Object(r2, filePath, image.size)

  await recordAssetIfMissing({
    authorPage,
    category,
    fileName,
    filePath,
    publicUrl,
    image,
    productId,
  })

  return {
    status: 'migrated',
    url: publicUrl,
  }
}

async function migrateProduct(r2, product, authorPage) {
  const result = {
    product_id: product.id,
    cover: 'unchanged',
    gallery_migrated: 0,
    gallery_pending: 0,
    gallery_external: 0,
    changed: false,
  }

  const coverResult = await migrateImage({
    r2,
    url: product.cover_url,
    authorPage,
    productId: product.id,
    category: 'author_store_cover',
  })

  result.cover = coverResult.status

  const gallery = Array.isArray(product.gallery_images)
    ? product.gallery_images
    : []
  const nextGallery = []

  for (let index = 0; index < gallery.length; index += 1) {
    const item = gallery[index]
    const itemUrl = galleryUrl(item)

    const imageResult = await migrateImage({
      r2,
      url: itemUrl,
      authorPage,
      productId: product.id,
      category: 'author_store_gallery',
      index,
    })

    if (imageResult.status === 'migrated') {
      result.gallery_migrated += 1
    } else if (imageResult.status === 'pending') {
      result.gallery_pending += 1
    } else if (imageResult.status === 'external') {
      result.gallery_external += 1
    }

    nextGallery.push(
      imageResult.url !== itemUrl
        ? replaceGalleryUrl(item, imageResult.url)
        : item
    )
  }

  const nextCoverUrl = coverResult.url
  const coverChanged = nextCoverUrl !== clean(product.cover_url)
  const galleryChanged =
    JSON.stringify(nextGallery) !== JSON.stringify(gallery)

  result.changed = coverChanged || galleryChanged

  if (isApplyMode() && result.changed) {
    const updates = {
      updated_at: new Date().toISOString(),
    }

    if (coverChanged) updates.cover_url = nextCoverUrl
    if (galleryChanged) updates.gallery_images = nextGallery

    const { error } = await supabase
      .from('author_store_products')
      .update(updates)
      .eq('id', product.id)

    if (error) throw error
  }

  return result
}

async function main() {
  requireConfig()

  const products = await readAllProducts()
  const authorPageIds = [
    ...new Set(
      products
        .map((product) => product.author_page_id)
        .filter(Boolean)
        .map(String)
    ),
  ]
  const authorPages = await readAuthorPages(authorPageIds)
  const r2 = makeR2Client()

  const summary = {
    mode: config.mode,
    products_total: products.length,
    products_processed: 0,
    products_changed: 0,
    products_failed: 0,
    covers_migrated: 0,
    covers_pending: 0,
    covers_external: 0,
    gallery_migrated: 0,
    gallery_pending: 0,
    gallery_external: 0,
  }

  for (const product of products) {
    const authorPage = authorPages.get(String(product.author_page_id))

    if (!authorPage) {
      summary.products_failed += 1
      console.error(
        `FAILED ${product.id}: author page ${product.author_page_id || 'missing'} not found`
      )
      continue
    }

    try {
      const result = await migrateProduct(r2, product, authorPage)

      summary.products_processed += 1
      if (result.changed) summary.products_changed += 1
      if (result.cover === 'migrated') summary.covers_migrated += 1
      if (result.cover === 'pending') summary.covers_pending += 1
      if (result.cover === 'external') summary.covers_external += 1
      summary.gallery_migrated += result.gallery_migrated
      summary.gallery_pending += result.gallery_pending
      summary.gallery_external += result.gallery_external

      console.log(JSON.stringify(result))
    } catch (error) {
      summary.products_failed += 1
      console.error(
        `FAILED ${product.id}: ${error.message}`
      )
    }
  }

  console.log(JSON.stringify(summary, null, 2))

  if (summary.products_failed > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
