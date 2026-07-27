import dotenv from 'dotenv'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { supabase } from '../src/config/supabase.js'

dotenv.config()

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

const BACKUP_TABLES = [
  {
    table:
      'shadow_mall_image_url_backup_r2',
    field: 'old_url',
  },
  {
    table:
      'slides_image_url_backup_r2',
    field: 'image_url',
  },
  {
    table:
      'media_url_backup_r2',
    field: 'old_url',
  },
  {
    table:
      'ads_image_url_backup_r2',
    field: 'old_url',
  },
]

function clean(value) {
  return String(value || '').trim()
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

function isSupabaseStorageUrl(value) {
  const url = clean(value)

  return (
    url.includes(
      '/storage/v1/object/'
    ) &&
    url.includes('supabase.co')
  )
}

function r2KeyFromUrl(value) {
  const url = clean(value)

  if (
    !url ||
    !config.publicUrl ||
    !url.startsWith(
      `${config.publicUrl}/`
    )
  ) {
    return null
  }

  try {
    return decodeURIComponent(
      url
        .slice(
          config.publicUrl.length + 1
        )
        .split('?')[0]
    )
  } catch {
    return url
      .slice(
        config.publicUrl.length + 1
      )
      .split('?')[0]
  }
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

async function safeReadAllRows(
  tableName
) {
  try {
    return {
      rows:
        await readAllRows(
          tableName
        ),
      error: null,
    }
  } catch (error) {
    return {
      rows: [],
      error:
        error.message,
    }
  }
}

async function headExists({
  client,
  key,
}) {
  try {
    const result =
      await client.send(
        new HeadObjectCommand({
          Bucket: config.bucket,
          Key: key,
        })
      )

    return {
      exists: true,
      size: Number(
        result.ContentLength || 0
      ),
      content_type:
        result.ContentType || null,
      etag: clean(
        result.ETag
      ).replace(/^"|"$/g, ''),
    }
  } catch (error) {
    return {
      exists: false,
      error:
        error.name ||
        error.message,
    }
  }
}

async function countR2Objects(
  client
) {
  let count = 0
  let size = 0
  let continuationToken

  do {
    const result =
      await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          ContinuationToken:
            continuationToken,
          MaxKeys: 1000,
        })
      )

    for (
      const object of
      result.Contents || []
    ) {
      count += 1
      size += Number(
        object.Size || 0
      )
    }

    continuationToken =
      result.IsTruncated
        ? result.NextContinuationToken
        : undefined
  } while (continuationToken)

  return {
    object_count: count,
    total_bytes: size,
  }
}

async function listStorageFolder({
  bucket,
  folder = '',
  output,
}) {
  let offset = 0

  while (true) {
    const { data, error } =
      await supabase.storage
        .from(bucket)
        .list(folder, {
          limit: 1000,
          offset,
          sortBy: {
            column: 'name',
            order: 'asc',
          },
        })

    if (error) throw error

    const rows = data || []

    for (const row of rows) {
      const objectPath = folder
        ? `${folder}/${row.name}`
        : row.name
      const isFolder =
        !row.id &&
        !row.metadata

      if (isFolder) {
        await listStorageFolder({
          bucket,
          folder:
            objectPath,
          output,
        })
      } else {
        output.push({
          bucket,
          object_path:
            objectPath,
          size: Number(
            row.metadata?.size || 0
          ),
        })
      }
    }

    if (rows.length < 1000) {
      break
    }

    offset += 1000
  }
}

async function supabaseStorageSummary() {
  const { data, error } =
    await supabase.storage
      .listBuckets()

  if (error) throw error

  const buckets = []

  for (
    const bucket of
    data || []
  ) {
    const objects = []
    let scanError = null

    try {
      await listStorageFolder({
        bucket: bucket.id,
        output: objects,
      })
    } catch (error) {
      scanError =
        error.message
    }

    buckets.push({
      bucket_id: bucket.id,
      public:
        Boolean(bucket.public),
      object_count:
        objects.length,
      total_bytes:
        objects.reduce(
          (sum, object) =>
            sum +
            Number(
              object.size || 0
            ),
          0
        ),
      scan_error:
        scanError,
    })
  }

  return buckets
}

async function main() {
  requireConfig()

  const client = makeR2Client()

  const [
    usersResult,
    slidesResult,
    purchaseResult,
    assetsResult,
  ] = await Promise.all([
    safeReadAllRows('users'),
    safeReadAllRows(
      'story_carousel_slides'
    ),
    safeReadAllRows(
      'purchase_requests'
    ),
    safeReadAllRows(
      'r2_assets'
    ),
  ])

  const activeRows = [
    ...usersResult.rows.map(
      (row) => ({
        table: 'users',
        id: row.id,
        field: 'avatar_url',
        url: row.avatar_url,
      })
    ),
    ...slidesResult.rows.map(
      (row) => ({
        table:
          'story_carousel_slides',
        id: row.id,
        field: 'image_url',
        url: row.image_url,
      })
    ),
    ...purchaseResult.rows.map(
      (row) => ({
        table:
          'purchase_requests',
        id: row.id,
        field: 'proof_url',
        url: row.proof_url,
      })
    ),
  ].filter((row) =>
    clean(row.url)
  )

  const activeSupabase =
    activeRows.filter((row) =>
      isSupabaseStorageUrl(
        row.url
      )
    )
  const activeR2 =
    activeRows
      .map((row) => ({
        ...row,
        r2_key:
          r2KeyFromUrl(
            row.url
          ),
      }))
      .filter((row) =>
        row.r2_key
      )
  const external =
    activeRows.filter(
      (row) =>
        !isSupabaseStorageUrl(
          row.url
        ) &&
        !r2KeyFromUrl(
          row.url
        )
    )

  const activeR2Checks = []

  for (
    const row of activeR2
  ) {
    const check =
      await headExists({
        client,
        key: row.r2_key,
      })

    activeR2Checks.push({
      ...row,
      ...check,
    })
  }

  const missingActiveR2 =
    activeR2Checks.filter(
      (row) =>
        !row.exists
    )

  const backup = []

  for (
    const definition of
    BACKUP_TABLES
  ) {
    const result =
      await safeReadAllRows(
        definition.table
      )

    backup.push({
      table:
        definition.table,
      field:
        definition.field,
      read_error:
        result.error,
      supabase_reference_count:
        result.rows.filter(
          (row) =>
            isSupabaseStorageUrl(
              row[
                definition.field
              ]
            )
        ).length,
    })
  }

  const r2AssetChecks = []

  for (
    const row of
    assetsResult.rows
  ) {
    const key = clean(
      row.file_path
    )

    if (!key) continue

    const check =
      await headExists({
        client,
        key,
      })

    r2AssetChecks.push({
      id: row.id,
      file_path: key,
      source_table:
        row.source_table,
      source_id:
        row.source_id,
      ...check,
    })
  }

  const missingR2Assets =
    r2AssetChecks.filter(
      (row) =>
        !row.exists
    )
  const r2Summary =
    await countR2Objects(
      client
    )
  const storageBuckets =
    await supabaseStorageSummary()

  const report = {
    generated_at:
      new Date().toISOString(),
    success:
      activeSupabase.length === 0 &&
      missingActiveR2.length === 0,
    active_database: {
      non_empty_references:
        activeRows.length,
      supabase_references:
        activeSupabase.length,
      r2_references:
        activeR2.length,
      external_references:
        external.length,
      missing_active_r2_objects:
        missingActiveR2.length,
    },
    table_read_errors: {
      users:
        usersResult.error,
      story_carousel_slides:
        slidesResult.error,
      purchase_requests:
        purchaseResult.error,
      r2_assets:
        assetsResult.error,
    },
    backup_references:
      backup,
    r2_bucket: {
      bucket:
        config.bucket,
      ...r2Summary,
      r2_asset_rows_checked:
        r2AssetChecks.length,
      missing_r2_asset_objects:
        missingR2Assets.length,
    },
    supabase_storage:
      storageBuckets,
    active_supabase_rows:
      activeSupabase,
    missing_active_r2_objects:
      missingActiveR2,
    external_active_rows:
      external,
    missing_r2_assets:
      missingR2Assets,
  }

  await fs.mkdir(
    OUTPUT_DIR,
    { recursive: true }
  )

  const reportPath = path.join(
    OUTPUT_DIR,
    'final-storage-migration-audit.json'
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

  console.log(
    '\nFINAL STORAGE AUDIT COMPLETE\n'
  )
  console.log(
    JSON.stringify(
      {
        success:
          report.success,
        active_supabase_references:
          report.active_database
            .supabase_references,
        active_r2_references:
          report.active_database
            .r2_references,
        external_active_references:
          report.active_database
            .external_references,
        missing_active_r2_objects:
          report.active_database
            .missing_active_r2_objects,
        r2_object_count:
          report.r2_bucket
            .object_count,
        missing_r2_asset_objects:
          report.r2_bucket
            .missing_r2_asset_objects,
        supabase_storage:
          report.supabase_storage,
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
    '\nFINAL STORAGE AUDIT FAILED\n'
  )
  console.error(error)
  process.exit(1)
})
