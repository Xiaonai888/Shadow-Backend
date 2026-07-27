import dotenv from 'dotenv'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { supabase } from '../src/config/supabase.js'

dotenv.config()

const CONFIRM_VALUE = 'TRANSFER_ACTIVE_MEDIA'
const OUTPUT_DIR = path.resolve(
  process.cwd(),
  'storage-migration-output'
)

function env(...names) {
  for (const name of names) {
    const value = String(
      process.env[name] || ''
    ).trim()

    if (value) return value
  }

  return ''
}

const config = {
  accountId: env('R2_ACCOUNT_ID'),
  accessKeyId: env(
    'CLOUDFLARE_R2_ACCESS_KEY_ID',
    'R2_ACCESS_KEY_ID'
  ),
  secretAccessKey: env(
    'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
    'R2_SECRET_ACCESS_KEY'
  ),
  bucket: env(
    'CLOUDFLARE_R2_BUCKET',
    'R2_BUCKET_NAME'
  ),
  publicUrl: env(
    'CLOUDFLARE_R2_PUBLIC_URL',
    'R2_PUBLIC_URL'
  ).replace(/\/+$/, ''),
  endpoint: env(
    'CLOUDFLARE_R2_ENDPOINT'
  ),
}

function requireConfig() {
  const missing = []

  if (!config.accountId) {
    missing.push('R2_ACCOUNT_ID')
  }

  if (!config.accessKeyId) {
    missing.push(
      'R2_ACCESS_KEY_ID'
    )
  }

  if (!config.secretAccessKey) {
    missing.push(
      'R2_SECRET_ACCESS_KEY'
    )
  }

  if (!config.bucket) {
    missing.push('R2_BUCKET_NAME')
  }

  if (!config.publicUrl) {
    missing.push('R2_PUBLIC_URL')
  }

  if (missing.length) {
    throw new Error(
      `Missing environment: ${missing.join(', ')}`
    )
  }
}

function makeR2Client() {
  const endpoint =
    config.endpoint ||
    `https://${config.accountId}.r2.cloudflarestorage.com`

  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId:
        config.accessKeyId,
      secretAccessKey:
        config.secretAccessKey,
    },
  })
}

function clean(value) {
  return String(value || '').trim()
}

function isSupabaseStorageUrl(value) {
  const url = clean(value)

  return (
    url.includes(
      '/storage/v1/object/'
    ) &&
    url.includes('supabase.co')
  )
}

function safePart(
  value,
  fallback = 'file'
) {
  const output = clean(value)
    .replace(
      /[^a-zA-Z0-9_-]+/g,
      '-'
    )
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)

  return output || fallback
}

function sourceName(url) {
  try {
    const pathname =
      new URL(url).pathname
    const name =
      pathname.split('/').pop()

    return decodeURIComponent(
      name || 'file'
    )
  } catch {
    return 'file'
  }
}

function extensionFrom({
  url,
  contentType,
}) {
  const name = sourceName(url)
  const fromName = name
    .split('.')
    .pop()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

  if (
    fromName &&
    fromName !== name.toLowerCase() &&
    fromName.length <= 6
  ) {
    return fromName === 'jpeg'
      ? 'jpg'
      : fromName
  }

  const type = clean(
    contentType
  ).toLowerCase()

  if (type.includes('webp')) {
    return 'webp'
  }

  if (type.includes('png')) {
    return 'png'
  }

  if (type.includes('gif')) {
    return 'gif'
  }

  if (type.includes('avif')) {
    return 'avif'
  }

  if (type.includes('svg')) {
    return 'svg'
  }

  if (type.includes('pdf')) {
    return 'pdf'
  }

  return 'jpg'
}

async function readAllRows(
  tableName
) {
  const rows = []
  const pageSize = 1000
  let from = 0

  while (true) {
    const { data, error } =
      await supabase
        .from(tableName)
        .select('*')
        .range(
          from,
          from + pageSize - 1
        )

    if (error) throw error

    const page = data || []
    rows.push(...page)

    if (
      page.length < pageSize
    ) {
      break
    }

    from += pageSize
  }

  return rows
}

async function downloadFile(url) {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}`
    )
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  )

  if (!buffer.length) {
    throw new Error(
      'Downloaded file is empty'
    )
  }

  const contentType =
    response.headers.get(
      'content-type'
    ) ||
    'application/octet-stream'

  return {
    buffer,
    contentType,
    size: buffer.length,
    sha256: crypto
      .createHash('sha256')
      .update(buffer)
      .digest('hex'),
  }
}

async function uploadAndVerify({
  client,
  key,
  file,
}) {
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: file.buffer,
      ContentType:
        file.contentType,
      CacheControl:
        'public, max-age=31536000, immutable',
      Metadata: {
        sha256: file.sha256,
        migrated_from:
          'supabase-storage',
      },
    })
  )

  const head = await client.send(
    new HeadObjectCommand({
      Bucket: config.bucket,
      Key: key,
    })
  )

  const r2Size = Number(
    head.ContentLength || 0
  )
  const r2Hash = clean(
    head.Metadata?.sha256
  )

  if (r2Size !== file.size) {
    throw new Error(
      `R2 size mismatch: source=${file.size}, r2=${r2Size}`
    )
  }

  if (
    r2Hash &&
    r2Hash !== file.sha256
  ) {
    throw new Error(
      'R2 SHA-256 mismatch'
    )
  }

  return {
    size: r2Size,
    sha256:
      r2Hash || file.sha256,
    etag: clean(
      head.ETag
    ).replace(/^"|"$/g, ''),
  }
}

async function recordAsset({
  category,
  fileName,
  key,
  publicUrl,
  file,
  ownerType,
  ownerId,
  ownerLabel,
  sourceTable,
  sourceId,
}) {
  const { error } = await supabase
    .from('r2_assets')
    .insert({
      category,
      file_name: fileName,
      file_path: key,
      public_url: publicUrl,
      mime_type:
        file.contentType,
      file_size: file.size,
      uploaded_by:
        'migration',
      source_table:
        sourceTable,
      source_id:
        sourceId || null,
      owner_type:
        ownerType,
      owner_id:
        ownerId || null,
      owner_label:
        ownerLabel || null,
      asset_status:
        'active',
    })

  if (error) {
    return error.message
  }

  return null
}

async function migrateUserAvatar({
  client,
  row,
}) {
  const oldUrl = clean(
    row.avatar_url
  )
  const file =
    await downloadFile(oldUrl)
  const extension =
    extensionFrom({
      url: oldUrl,
      contentType:
        file.contentType,
    })
  const hash =
    file.sha256.slice(0, 16)
  const key =
    `users/avatars/${safePart(row.id)}/migrated-${hash}.${extension}`
  const publicUrl =
    `${config.publicUrl}/${key}`

  const verified =
    await uploadAndVerify({
      client,
      key,
      file,
    })

  const { error } = await supabase
    .from('users')
    .update({
      avatar_url: publicUrl,
      updated_at:
        new Date().toISOString(),
    })
    .eq('id', row.id)

  if (error) throw error

  const recordWarning =
    await recordAsset({
      category:
        'reader_avatar',
      fileName:
        key.split('/').pop(),
      key,
      publicUrl,
      file,
      ownerType: 'user',
      ownerId: row.id,
      ownerLabel:
        row.username ||
        row.name ||
        null,
      sourceTable: 'users',
      sourceId: row.id,
    })

  return {
    old_url: oldUrl,
    new_url: publicUrl,
    r2_key: key,
    source_size:
      file.size,
    r2_size:
      verified.size,
    sha256:
      verified.sha256,
    asset_record_warning:
      recordWarning,
  }
}

async function migrateStorySlide({
  client,
  row,
}) {
  const oldUrl = clean(
    row.image_url
  )
  const file =
    await downloadFile(oldUrl)
  const extension =
    extensionFrom({
      url: oldUrl,
      contentType:
        file.contentType,
    })
  const hash =
    file.sha256.slice(0, 16)
  const storyId = safePart(
    row.story_id,
    'unknown-story'
  )
  const key =
    `story-carousel/${storyId}/${safePart(row.id)}-${hash}.${extension}`
  const publicUrl =
    `${config.publicUrl}/${key}`

  const verified =
    await uploadAndVerify({
      client,
      key,
      file,
    })

  const patch = {
    image_url: publicUrl,
  }

  if (
    Object.prototype.hasOwnProperty.call(
      row,
      'updated_at'
    )
  ) {
    patch.updated_at =
      new Date().toISOString()
  }

  const { error } = await supabase
    .from(
      'story_carousel_slides'
    )
    .update(patch)
    .eq('id', row.id)

  if (error) throw error

  const recordWarning =
    await recordAsset({
      category:
        'story_carousel_slide',
      fileName:
        key.split('/').pop(),
      key,
      publicUrl,
      file,
      ownerType: 'story',
      ownerId:
        row.story_id || null,
      ownerLabel:
        'Story carousel slide',
      sourceTable:
        'story_carousel_slides',
      sourceId: row.id,
    })

  return {
    old_url: oldUrl,
    new_url: publicUrl,
    r2_key: key,
    source_size:
      file.size,
    r2_size:
      verified.size,
    sha256:
      verified.sha256,
    asset_record_warning:
      recordWarning,
  }
}

async function migratePurchaseProof({
  client,
  row,
}) {
  const oldUrl = clean(
    row.proof_url
  )
  const file =
    await downloadFile(oldUrl)
  const extension =
    extensionFrom({
      url: oldUrl,
      contentType:
        file.contentType,
    })
  const hash =
    file.sha256.slice(0, 16)
  const originalName =
    sourceName(oldUrl)
  const key =
    `purchase-proofs/${safePart(row.id)}/migrated-${hash}.${extension}`
  const publicUrl =
    `${config.publicUrl}/${key}`

  const verified =
    await uploadAndVerify({
      client,
      key,
      file,
    })

  const { error } = await supabase
    .from('purchase_requests')
    .update({
      proof_url: publicUrl,
      proof_storage_key: key,
      proof_file_name:
        originalName,
      proof_mime_type:
        file.contentType,
      proof_file_size:
        file.size,
      updated_at:
        new Date().toISOString(),
    })
    .eq('id', row.id)

  if (error) throw error

  const recordWarning =
    await recordAsset({
      category:
        'purchase_proof',
      fileName:
        key.split('/').pop(),
      key,
      publicUrl,
      file,
      ownerType: 'user',
      ownerId:
        row.user_id || null,
      ownerLabel:
        row.payer_name ||
        'Purchase proof',
      sourceTable:
        'purchase_requests',
      sourceId: row.id,
    })

  return {
    old_url: oldUrl,
    new_url: publicUrl,
    r2_key: key,
    source_size:
      file.size,
    r2_size:
      verified.size,
    sha256:
      verified.sha256,
    asset_record_warning:
      recordWarning,
  }
}

async function remainingActiveReferences() {
  const [
    users,
    slides,
    purchases,
  ] = await Promise.all([
    readAllRows('users'),
    readAllRows(
      'story_carousel_slides'
    ),
    readAllRows(
      'purchase_requests'
    ),
  ])

  return {
    users_avatar_url:
      users.filter((row) =>
        isSupabaseStorageUrl(
          row.avatar_url
        )
      ).length,
    story_carousel_slides_image_url:
      slides.filter((row) =>
        isSupabaseStorageUrl(
          row.image_url
        )
      ).length,
    purchase_requests_proof_url:
      purchases.filter((row) =>
        isSupabaseStorageUrl(
          row.proof_url
        )
      ).length,
  }
}

async function writeReport(
  report
) {
  await fs.mkdir(
    OUTPUT_DIR,
    { recursive: true }
  )

  const reportPath = path.join(
    OUTPUT_DIR,
    'active-supabase-media-to-r2.json'
  )

  await fs.writeFile(
    reportPath,
    JSON.stringify(
      report,
      null,
      2
    ),
    'utf8'
  )

  return reportPath
}

async function runGroup({
  name,
  rows,
  migrate,
  client,
}) {
  const candidates =
    rows.filter((row) =>
      isSupabaseStorageUrl(
        row.url
      )
    )
  const results = []

  console.log(
    `\n${name}: ${candidates.length} candidate(s)`
  )

  for (
    let index = 0;
    index < candidates.length;
    index += 1
  ) {
    const item =
      candidates[index]
    const label =
      `${index + 1}/${candidates.length} ${name} ${item.row.id}`

    try {
      console.log(
        `${label} transferring...`
      )

      const detail =
        await migrate({
          client,
          row: item.row,
        })

      results.push({
        id: item.row.id,
        status: 'MIGRATED',
        ...detail,
      })

      console.log(
        `${label} verified`
      )
    } catch (error) {
      results.push({
        id: item.row.id,
        status: 'FAILED',
        old_url: item.url,
        error:
          error.message,
      })

      console.error(
        `${label} failed: ${error.message}`
      )
    }
  }

  return results
}

async function main() {
  requireConfig()

  if (
    clean(
      process.env.MIGRATION_CONFIRM
    ) !== CONFIRM_VALUE
  ) {
    throw new Error(
      `Run with MIGRATION_CONFIRM=${CONFIRM_VALUE}`
    )
  }

  const client = makeR2Client()

  const [
    users,
    slides,
    purchases,
  ] = await Promise.all([
    readAllRows('users'),
    readAllRows(
      'story_carousel_slides'
    ),
    readAllRows(
      'purchase_requests'
    ),
  ])

  const groups = {
    users: await runGroup({
      name: 'users.avatar_url',
      rows: users.map((row) => ({
        row,
        url: row.avatar_url,
      })),
      migrate:
        migrateUserAvatar,
      client,
    }),
    story_carousel_slides:
      await runGroup({
        name:
          'story_carousel_slides.image_url',
        rows: slides.map(
          (row) => ({
            row,
            url: row.image_url,
          })
        ),
        migrate:
          migrateStorySlide,
        client,
      }),
    purchase_requests:
      await runGroup({
        name:
          'purchase_requests.proof_url',
        rows: purchases.map(
          (row) => ({
            row,
            url: row.proof_url,
          })
        ),
        migrate:
          migratePurchaseProof,
        client,
      }),
  }

  const allResults =
    Object.values(
      groups
    ).flat()
  const migrated =
    allResults.filter(
      (item) =>
        item.status === 'MIGRATED'
    ).length
  const failed =
    allResults.filter(
      (item) =>
        item.status === 'FAILED'
    ).length
  const remaining =
    await remainingActiveReferences()
  const remainingTotal =
    Object.values(
      remaining
    ).reduce(
      (sum, value) =>
        sum + Number(value || 0),
      0
    )

  const report = {
    generated_at:
      new Date().toISOString(),
    mode:
      'TRANSFER_WITHOUT_SOURCE_DELETE',
    r2_bucket:
      config.bucket,
    r2_public_url:
      config.publicUrl,
    migrated,
    failed,
    remaining_active_supabase_references:
      remaining,
    remaining_active_total:
      remainingTotal,
    success:
      failed === 0 &&
      remainingTotal === 0,
    source_deletion:
      'NOT_PERFORMED',
    groups,
  }

  const reportPath =
    await writeReport(report)

  console.log(
    '\nACTIVE MEDIA MIGRATION COMPLETE\n'
  )
  console.log(
    JSON.stringify(
      {
        migrated:
          report.migrated,
        failed:
          report.failed,
        remaining_active_total:
          report.remaining_active_total,
        success:
          report.success,
        source_deletion:
          report.source_deletion,
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
    '\nACTIVE MEDIA MIGRATION FAILED\n'
  )
  console.error(error)
  process.exit(1)
})
