import dotenv from 'dotenv'
import {
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { supabase } from '../src/config/supabase.js'
import fs from 'node:fs/promises'
import path from 'node:path'

dotenv.config()

const REQUIRED_ENV = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_PUBLIC_URL',
]

const TABLES_TO_SCAN = [
  'users',
  'story_carousel_slides',
  'purchase_requests',
  'support_requests',
  'r2_assets',
  'shadow_mall_image_url_backup_r2',
  'slides_image_url_backup_r2',
  'media_url_backup_r2',
  'ads_image_url_backup_r2',
]

const BACKUP_TABLES = new Set([
  'shadow_mall_image_url_backup_r2',
  'slides_image_url_backup_r2',
  'media_url_backup_r2',
  'ads_image_url_backup_r2',
])

const PLAIN_STORAGE_PATHS = {
  support_requests: {
    screenshot_path: 'support-screenshots',
  },
}

const OUTPUT_DIR = path.resolve(
  process.cwd(),
  'storage-audit-output'
)

function requireEnvironment() {
  const missing = REQUIRED_ENV.filter(
    (key) =>
      !String(
        process.env[key] || ''
      ).trim()
  )

  if (missing.length) {
    throw new Error(
      `Missing environment: ${missing.join(', ')}`
    )
  }
}

function clean(value) {
  return String(value || '').trim()
}

function normalizeBaseUrl(value) {
  return clean(value).replace(/\/+$/, '')
}

function bytes(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? number
    : 0
}

function formatBytes(value) {
  const size = bytes(value)

  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) {
    return `${(size / 1024).toFixed(2)} KB`
  }
  if (size < 1024 ** 3) {
    return `${(size / 1024 ** 2).toFixed(2)} MB`
  }

  return `${(size / 1024 ** 3).toFixed(2)} GB`
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseSupabaseStorageUrl(value) {
  const text = clean(value)

  if (!text) return null

  const match = text.match(
    /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/?#]+)\/([^?#]+)/
  )

  if (!match) return null

  return {
    bucket: decodeSafe(match[1]),
    objectPath: decodeSafe(match[2]),
  }
}

function parseR2Url(value, publicBaseUrl) {
  const text = clean(value)

  if (
    !text ||
    !publicBaseUrl ||
    !text.startsWith(`${publicBaseUrl}/`)
  ) {
    return null
  }

  return decodeSafe(
    text
      .slice(publicBaseUrl.length + 1)
      .split('?')[0]
  )
}

function flattenStrings(
  value,
  prefix = '',
  output = []
) {
  if (
    value === null ||
    value === undefined
  ) {
    return output
  }

  if (typeof value === 'string') {
    output.push({
      field: prefix,
      value,
    })
    return output
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenStrings(
        item,
        `${prefix}[${index}]`,
        output
      )
    })
    return output
  }

  if (
    typeof value === 'object'
  ) {
    Object.entries(value).forEach(
      ([key, item]) => {
        flattenStrings(
          item,
          prefix
            ? `${prefix}.${key}`
            : key,
          output
        )
      }
    )
  }

  return output
}

function csvEscape(value) {
  const text = String(
    value ?? ''
  )

  if (
    text.includes(',') ||
    text.includes('"') ||
    text.includes('\n')
  ) {
    return `"${text.replace(/"/g, '""')}"`
  }

  return text
}

function makeCsv(rows) {
  if (!rows.length) return ''

  const columns = [
    ...new Set(
      rows.flatMap(
        (row) =>
          Object.keys(row)
      )
    ),
  ]

  return [
    columns
      .map(csvEscape)
      .join(','),
    ...rows.map((row) =>
      columns
        .map((column) =>
          csvEscape(row[column])
        )
        .join(',')
    ),
  ].join('\n')
}

async function writeJson(
  name,
  value
) {
  await fs.writeFile(
    path.join(
      OUTPUT_DIR,
      name
    ),
    JSON.stringify(
      value,
      null,
      2
    ),
    'utf8'
  )
}

async function writeCsv(
  name,
  rows
) {
  await fs.writeFile(
    path.join(
      OUTPUT_DIR,
      name
    ),
    makeCsv(rows),
    'utf8'
  )
}

function makeR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint:
      `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:
        process.env.R2_ACCESS_KEY_ID,
      secretAccessKey:
        process.env.R2_SECRET_ACCESS_KEY,
    },
  })
}

async function listAllR2Objects(
  client
) {
  const objects = []
  let continuationToken

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket:
          process.env.R2_BUCKET_NAME,
        ContinuationToken:
          continuationToken,
        MaxKeys: 1000,
      })
    )

    for (
      const item of
      response.Contents || []
    ) {
      objects.push({
        key: item.Key || '',
        size: bytes(item.Size),
        etag: clean(
          item.ETag
        ).replace(/^"|"$/g, ''),
        last_modified:
          item.LastModified
            ? new Date(
                item.LastModified
              ).toISOString()
            : null,
      })
    }

    continuationToken =
      response.IsTruncated
        ? response.NextContinuationToken
        : undefined
  } while (continuationToken)

  return objects
}

async function listSupabaseFolder({
  bucket,
  folder = '',
  output,
}) {
  let offset = 0

  while (true) {
    const {
      data,
      error,
    } = await supabase.storage
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

    const items = data || []

    for (const item of items) {
      const objectPath = folder
        ? `${folder}/${item.name}`
        : item.name
      const isFolder =
        !item.id &&
        !item.metadata

      if (isFolder) {
        await listSupabaseFolder({
          bucket,
          folder: objectPath,
          output,
        })
        continue
      }

      output.push({
        bucket,
        object_path:
          objectPath,
        size: bytes(
          item.metadata?.size
        ),
        mimetype:
          item.metadata?.mimetype ||
          '',
        created_at:
          item.created_at ||
          null,
        updated_at:
          item.updated_at ||
          null,
      })
    }

    if (items.length < 1000) {
      break
    }

    offset += 1000
  }
}

async function listAllSupabaseObjects() {
  const {
    data: buckets,
    error,
  } = await supabase.storage
    .listBuckets()

  if (error) throw error

  const objects = []
  const errors = []

  for (
    const bucket of
    buckets || []
  ) {
    try {
      await listSupabaseFolder({
        bucket: bucket.id,
        output: objects,
      })
    } catch (bucketError) {
      errors.push({
        bucket: bucket.id,
        error:
          bucketError.message,
      })
    }
  }

  return {
    buckets:
      buckets || [],
    objects,
    errors,
  }
}

async function readAllRows(
  tableName
) {
  const rows = []
  let from = 0
  const limit = 1000

  while (true) {
    const {
      data,
      error,
    } = await supabase
      .from(tableName)
      .select('*')
      .range(
        from,
        from + limit - 1
      )

    if (error) throw error

    const page =
      data || []

    rows.push(...page)

    if (page.length < limit) {
      break
    }

    from += limit
  }

  return rows
}

async function scanDatabaseReferences(
  publicBaseUrl
) {
  const supabaseReferences = []
  const r2References = []
  const tableResults = []

  for (
    const tableName of
    TABLES_TO_SCAN
  ) {
    try {
      const rows =
        await readAllRows(
          tableName
        )

      for (
        const row of rows
      ) {
        const rowId =
          row.id ??
          row.source_id ??
          row.user_id ??
          null
        const strings =
          flattenStrings(row)

        for (
          const item of strings
        ) {
          const supabaseRef =
            parseSupabaseStorageUrl(
              item.value
            )

          if (supabaseRef) {
            supabaseReferences.push({
              table:
                tableName,
              row_id:
                rowId,
              field:
                item.field,
              value:
                item.value,
              bucket:
                supabaseRef.bucket,
              object_path:
                supabaseRef.objectPath,
              is_backup:
                BACKUP_TABLES.has(
                  tableName
                ),
            })
          }

          const r2Key =
            parseR2Url(
              item.value,
              publicBaseUrl
            )

          if (r2Key) {
            r2References.push({
              table:
                tableName,
              row_id:
                rowId,
              field:
                item.field,
              value:
                item.value,
              r2_key:
                r2Key,
              is_backup:
                BACKUP_TABLES.has(
                  tableName
                ),
            })
          }

          const fieldName =
            item.field
              .split('.')
              .at(-1)
          const plainBucket =
            PLAIN_STORAGE_PATHS[
              tableName
            ]?.[fieldName]

          if (
            plainBucket &&
            clean(item.value)
          ) {
            supabaseReferences.push({
              table:
                tableName,
              row_id:
                rowId,
              field:
                item.field,
              value:
                item.value,
              bucket:
                plainBucket,
              object_path:
                clean(item.value),
              is_backup: false,
            })
          }

          if (
            tableName ===
              'r2_assets' &&
            fieldName ===
              'file_path' &&
            clean(item.value)
          ) {
            r2References.push({
              table:
                tableName,
              row_id:
                rowId,
              field:
                item.field,
              value:
                item.value,
              r2_key:
                clean(item.value),
              is_backup: false,
            })
          }
        }
      }

      tableResults.push({
        table:
          tableName,
        rows:
          rows.length,
        status: 'ok',
      })
    } catch (error) {
      tableResults.push({
        table:
          tableName,
        rows: 0,
        status: 'error',
        error:
          error.message,
      })
    }
  }

  return {
    supabaseReferences,
    r2References,
    tableResults,
  }
}

function uniqueBy(
  rows,
  keyBuilder
) {
  const map = new Map()

  rows.forEach((row) => {
    const key =
      keyBuilder(row)

    if (!map.has(key)) {
      map.set(key, row)
    }
  })

  return [
    ...map.values(),
  ]
}

async function main() {
  requireEnvironment()

  await fs.mkdir(
    OUTPUT_DIR,
    { recursive: true }
  )

  const publicBaseUrl =
    normalizeBaseUrl(
      process.env.R2_PUBLIC_URL
    )
  const r2Client =
    makeR2Client()

  console.log(
    '1/3 Listing Cloudflare R2 objects...'
  )
  const r2Objects =
    await listAllR2Objects(
      r2Client
    )
  const r2Map = new Map(
    r2Objects.map(
      (item) => [
        item.key,
        item,
      ]
    )
  )

  console.log(
    '2/3 Listing Supabase Storage objects...'
  )
  const supabaseStorage =
    await listAllSupabaseObjects()
  const supabaseMap =
    new Map(
      supabaseStorage.objects.map(
        (item) => [
          `${item.bucket}/${item.object_path}`,
          item,
        ]
      )
    )

  console.log(
    '3/3 Scanning database references...'
  )
  const database =
    await scanDatabaseReferences(
      publicBaseUrl
    )

  const uniqueSupabaseRefs =
    uniqueBy(
      database.supabaseReferences,
      (item) =>
        `${item.table}|${item.row_id}|${item.field}|${item.bucket}|${item.object_path}`
    )
  const uniqueR2Refs =
    uniqueBy(
      database.r2References,
      (item) =>
        `${item.table}|${item.row_id}|${item.field}|${item.r2_key}`
    )

  const checkedSupabaseRefs =
    uniqueSupabaseRefs.map(
      (item) => ({
        ...item,
        exists_in_supabase:
          supabaseMap.has(
            `${item.bucket}/${item.object_path}`
          ),
      })
    )

  const checkedR2Refs =
    uniqueR2Refs.map(
      (item) => {
        const object =
          r2Map.get(
            item.r2_key
          )

        return {
          ...item,
          exists_in_r2:
            Boolean(object),
          r2_size:
            object?.size || 0,
          r2_last_modified:
            object
              ?.last_modified ||
            null,
        }
      }
    )

  const referencedSupabaseKeys =
    new Set(
      checkedSupabaseRefs.map(
        (item) =>
          `${item.bucket}/${item.object_path}`
      )
    )

  const supabaseUnusedCandidates =
    supabaseStorage.objects
      .filter(
        (item) =>
          !referencedSupabaseKeys.has(
            `${item.bucket}/${item.object_path}`
          )
      )
      .map((item) => ({
        ...item,
        status:
          'UNREFERENCED_CANDIDATE',
      }))

  const missingR2 =
    checkedR2Refs.filter(
      (item) =>
        !item.exists_in_r2
    )
  const missingSupabase =
    checkedSupabaseRefs.filter(
      (item) =>
        !item.exists_in_supabase
    )

  const activeSupabaseRefs =
    checkedSupabaseRefs.filter(
      (item) =>
        !item.is_backup
    )
  const backupSupabaseRefs =
    checkedSupabaseRefs.filter(
      (item) =>
        item.is_backup
    )

  const summary = {
    generated_at:
      new Date().toISOString(),
    mode: 'READ_ONLY',
    r2: {
      bucket:
        process.env.R2_BUCKET_NAME,
      public_url:
        publicBaseUrl,
      object_count:
        r2Objects.length,
      total_bytes:
        r2Objects.reduce(
          (sum, item) =>
            sum + item.size,
          0
        ),
      total_size:
        formatBytes(
          r2Objects.reduce(
            (sum, item) =>
              sum + item.size,
            0
          )
        ),
    },
    supabase_storage: {
      bucket_count:
        supabaseStorage.buckets.length,
      object_count:
        supabaseStorage.objects.length,
      total_bytes:
        supabaseStorage.objects.reduce(
          (sum, item) =>
            sum + item.size,
          0
        ),
      total_size:
        formatBytes(
          supabaseStorage.objects.reduce(
            (sum, item) =>
              sum + item.size,
            0
          )
        ),
      bucket_errors:
        supabaseStorage.errors,
    },
    database: {
      tables:
        database.tableResults,
      active_supabase_references:
        activeSupabaseRefs.length,
      backup_supabase_references:
        backupSupabaseRefs.length,
      r2_references:
        checkedR2Refs.length,
      missing_r2_objects:
        missingR2.length,
      missing_supabase_objects:
        missingSupabase.length,
    },
    cleanup: {
      unreferenced_supabase_candidates:
        supabaseUnusedCandidates.length,
      warning:
        'Candidates are not deleted by this audit. Verify each migration group before deletion.',
    },
  }

  await writeJson(
    'summary.json',
    summary
  )
  await writeCsv(
    'r2-objects.csv',
    r2Objects
  )
  await writeCsv(
    'supabase-objects.csv',
    supabaseStorage.objects
  )
  await writeCsv(
    'database-supabase-references.csv',
    checkedSupabaseRefs
  )
  await writeCsv(
    'database-r2-references.csv',
    checkedR2Refs
  )
  await writeCsv(
    'missing-r2-objects.csv',
    missingR2
  )
  await writeCsv(
    'missing-supabase-objects.csv',
    missingSupabase
  )
  await writeCsv(
    'supabase-unused-candidates.csv',
    supabaseUnusedCandidates
  )

  console.log(
    '\nSTORAGE AUDIT COMPLETE\n'
  )
  console.log(
    JSON.stringify(
      summary,
      null,
      2
    )
  )
  console.log(
    `\nReports: ${OUTPUT_DIR}`
  )
}

main().catch((error) => {
  console.error(
    '\nSTORAGE AUDIT FAILED\n'
  )
  console.error(
    error
  )
  process.exit(1)
})
