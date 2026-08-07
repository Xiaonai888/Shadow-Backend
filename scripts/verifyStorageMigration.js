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

const PAGE_SIZE = 1000
const LARGE_MEDIA_STRING_BYTES = 4096
const OUTPUT_DIR = path.resolve(
  process.cwd(),
  'storage-migration-output'
)

const NON_BLOCKING_REFERENCE_TABLES = new Set([
  'shadow_mall_image_url_backup_r2',
  'slides_image_url_backup_r2',
  'media_url_backup_r2',
  'ads_image_url_backup_r2',
  'storage_migrations',
])

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
  endpoint: env('CLOUDFLARE_R2_ENDPOINT'),
  supabaseUrl: env('SUPABASE_URL').replace(/\/+$/, ''),
  supabaseKey: env('SUPABASE_SERVICE_ROLE_KEY'),
}

function requireConfig() {
  const missing = []

  if (!config.accountId) {
    missing.push('R2_ACCOUNT_ID')
  }

  if (!config.accessKeyId) {
    missing.push('R2_ACCESS_KEY_ID')
  }

  if (!config.secretAccessKey) {
    missing.push('R2_SECRET_ACCESS_KEY')
  }

  if (!config.bucket) {
    missing.push('R2_BUCKET_NAME')
  }

  if (!config.publicUrl) {
    missing.push('R2_PUBLIC_URL')
  }

  if (!config.supabaseUrl) {
    missing.push('SUPABASE_URL')
  }

  if (!config.supabaseKey) {
    missing.push('SUPABASE_SERVICE_ROLE_KEY')
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
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
}

function isSupabaseStorageUrl(value) {
  const input = clean(value).toLowerCase()

  return (
    input.includes('supabase.co') &&
    (
      input.includes('/storage/v1/object/') ||
      input.includes('/storage/v1/render/image/')
    )
  )
}

function isInlineMediaValue(value) {
  const input = clean(value).toLowerCase()

  return (
    input.startsWith('data:') ||
    input.startsWith('blob:') ||
    input.startsWith('base64,') ||
    input.includes(';base64,')
  )
}

function isR2PublicUrl(value) {
  const input = clean(value)

  if (!input || !config.publicUrl) {
    return false
  }

  return (
    input === config.publicUrl ||
    input.startsWith(`${config.publicUrl}/`)
  )
}

function r2KeyFromUrl(value) {
  const input = clean(value)

  if (
    !input ||
    !config.publicUrl ||
    !input.startsWith(`${config.publicUrl}/`)
  ) {
    return null
  }

  const tail = input
    .slice(config.publicUrl.length + 1)
    .split('?')[0]
    .split('#')[0]

  try {
    return decodeURIComponent(tail)
  } catch {
    return tail
  }
}

function mediaFieldName(value) {
  const key = clean(value).replace(
    /[A-Z]/g,
    (match) => `_${match.toLowerCase()}`
  )

  return /(^|_)(image|img|avatar|cover|thumbnail|proof|qr_?image|audio|video|pdf|attachment|file|media)($|_)/i.test(
    key
  )
}

function knownBinaryType(buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    )
  ) {
    return 'image/png'
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg'
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }

  if (
    buffer.length >= 6 &&
    ['GIF87a', 'GIF89a'].includes(
      buffer.subarray(0, 6).toString('ascii')
    )
  ) {
    return 'image/gif'
  }

  if (
    buffer.length >= 5 &&
    buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  ) {
    return 'application/pdf'
  }

  if (
    buffer.length >= 4 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF'
  ) {
    return 'audio/wav'
  }

  return null
}

function looksLikeBareBase64Media(value, fieldName) {
  const input = clean(value)

  if (
    !mediaFieldName(fieldName) ||
    input.length < 128 ||
    input.length % 4 !== 0 ||
    !/^[a-z0-9+/=\s]+$/i.test(input)
  ) {
    return false
  }

  try {
    const buffer = Buffer.from(
      input.replace(/\s+/g, ''),
      'base64'
    )

    return Boolean(
      buffer.length &&
      knownBinaryType(buffer)
    )
  } catch {
    return false
  }
}

function looksLikeSuspiciousLargeMedia(value, fieldName) {
  const input = clean(value)

  if (
    !mediaFieldName(fieldName) ||
    input.length < LARGE_MEDIA_STRING_BYTES ||
    input.includes('://')
  ) {
    return false
  }

  return true
}

function rowIdentifier(row, index) {
  for (const key of [
    'id',
    'source_key',
    'order_id',
    'user_id',
    'story_id',
    'request_id',
  ]) {
    if (
      Object.prototype.hasOwnProperty.call(row, key) &&
      row[key] !== null &&
      row[key] !== undefined
    ) {
      return clean(row[key]) || `row-${index + 1}`
    }
  }

  return `row-${index + 1}`
}

function schemaProperties(openApi) {
  return (
    openApi?.components?.schemas ||
    openApi?.definitions ||
    {}
  )
}

function propertyType(schema) {
  if (!schema || typeof schema !== 'object') {
    return ''
  }

  if (schema.type) {
    return schema.type
  }

  if (schema.$ref) {
    return 'object'
  }

  if (
    schema.anyOf ||
    schema.oneOf ||
    schema.allOf
  ) {
    return 'object'
  }

  return ''
}

function candidateColumns(schema) {
  const properties = schema?.properties || {}

  return Object.entries(properties)
    .filter(([, definition]) => {
      const type = propertyType(definition)

      return [
        'string',
        'object',
        'array',
      ].includes(type)
    })
    .map(([name]) => name)
}

async function discoverDatabaseSchema() {
  const response = await fetch(
    `${config.supabaseUrl}/rest/v1/`,
    {
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
        Accept: 'application/openapi+json',
      },
    }
  )

  if (!response.ok) {
    throw new Error(
      `Supabase schema discovery failed: ${response.status} ${response.statusText}`
    )
  }

  const openApi = await response.json()
  const schemas = schemaProperties(openApi)

  return Object.entries(schemas)
    .map(([table, schema]) => ({
      table,
      columns: candidateColumns(schema),
    }))
    .filter((item) => item.columns.length)
    .sort((a, b) => a.table.localeCompare(b.table))
}

async function readTableColumns(table, columns) {
  const rows = []
  let from = 0
  const select = columns.join(',')

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(
        from,
        from + PAGE_SIZE - 1
      )

    if (error) throw error

    const page = data || []
    rows.push(...page)

    if (page.length < PAGE_SIZE) {
      break
    }

    from += PAGE_SIZE
  }

  return rows
}

function pushFinding(
  findings,
  {
    kind,
    table,
    rowId,
    column,
    path,
    value,
  }
) {
  findings.push({
    kind,
    table,
    row_id: rowId,
    column,
    path,
    value_preview:
      typeof value === 'string'
        ? value.slice(0, 500)
        : null,
    value_length:
      typeof value === 'string'
        ? value.length
        : null,
    blocking:
      !NON_BLOCKING_REFERENCE_TABLES.has(table),
  })
}

function scanValue({
  value,
  table,
  rowId,
  column,
  path,
  fieldName,
  findings,
  r2References,
}) {
  if (typeof value === 'string') {
    const input = clean(value)

    if (!input) return

    if (isSupabaseStorageUrl(input)) {
      pushFinding(findings, {
        kind: 'SUPABASE_STORAGE_REFERENCE',
        table,
        rowId,
        column,
        path,
        value: input,
      })

      return
    }

    if (
      isInlineMediaValue(input) ||
      looksLikeBareBase64Media(input, fieldName)
    ) {
      pushFinding(findings, {
        kind: 'INLINE_MEDIA_DATA',
        table,
        rowId,
        column,
        path,
        value: input,
      })

      return
    }

    if (
      looksLikeSuspiciousLargeMedia(
        input,
        fieldName
      )
    ) {
      pushFinding(findings, {
        kind: 'SUSPICIOUS_LARGE_MEDIA_STRING',
        table,
        rowId,
        column,
        path,
        value: input,
      })

      return
    }

    if (isR2PublicUrl(input)) {
      const key = r2KeyFromUrl(input)

      if (key) {
        const referenceKey =
          `${table}:${rowId}:${column}:${path}`

        r2References.set(referenceKey, {
          table,
          row_id: rowId,
          column,
          path,
          url: input,
          r2_key: key,
          blocking:
            !NON_BLOCKING_REFERENCE_TABLES.has(table),
        })
      }
    }

    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      scanValue({
        value: item,
        table,
        rowId,
        column,
        path: `${path}[${index}]`,
        fieldName,
        findings,
        r2References,
      })
    })

    return
  }

  if (
    value &&
    typeof value === 'object'
  ) {
    Object.entries(value).forEach(
      ([key, item]) => {
        scanValue({
          value: item,
          table,
          rowId,
          column,
          path: `${path}.${key}`,
          fieldName: key,
          findings,
          r2References,
        })
      }
    )
  }
}

async function scanDatabase() {
  const definitions =
    await discoverDatabaseSchema()

  const findings = []
  const r2References = new Map()
  const tableResults = []

  for (const definition of definitions) {
    try {
      const rows =
        await readTableColumns(
          definition.table,
          definition.columns
        )

      rows.forEach((row, index) => {
        const rowId =
          rowIdentifier(row, index)

        for (const column of definition.columns) {
          if (
            !Object.prototype.hasOwnProperty.call(
              row,
              column
            )
          ) {
            continue
          }

          scanValue({
            value: row[column],
            table: definition.table,
            rowId,
            column,
            path: `${definition.table}.${column}`,
            fieldName: column,
            findings,
            r2References,
          })
        }
      })

      tableResults.push({
        table: definition.table,
        columns_scanned:
          definition.columns.length,
        rows_scanned: rows.length,
        read_error: null,
      })
    } catch (error) {
      tableResults.push({
        table: definition.table,
        columns_scanned:
          definition.columns.length,
        rows_scanned: 0,
        read_error: error.message,
      })
    }
  }

  return {
    definitions,
    findings,
    r2References: [
      ...r2References.values(),
    ],
    tables: tableResults,
  }
}

async function headR2Object(client, key) {
  try {
    const result = await client.send(
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
      sha256: clean(
        result.Metadata?.sha256
      ) || null,
      content_type:
        result.ContentType || null,
      etag: clean(
        result.ETag
      ).replace(/^"|"$/g, ''),
      error: null,
    }
  } catch (error) {
    return {
      exists: false,
      size: 0,
      sha256: null,
      content_type: null,
      etag: null,
      error:
        error.name ||
        error.message,
    }
  }
}

async function verifyR2References(
  client,
  references
) {
  const cache = new Map()
  const results = []

  for (const reference of references) {
    if (!cache.has(reference.r2_key)) {
      cache.set(
        reference.r2_key,
        await headR2Object(
          client,
          reference.r2_key
        )
      )
    }

    results.push({
      ...reference,
      ...cache.get(reference.r2_key),
    })
  }

  return results
}

async function countR2Objects(client) {
  let count = 0
  let totalBytes = 0
  let continuationToken

  do {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        ContinuationToken:
          continuationToken,
        MaxKeys: 1000,
      })
    )

    for (const object of result.Contents || []) {
      count += 1
      totalBytes += Number(
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
    total_bytes: totalBytes,
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
          limit: PAGE_SIZE,
          offset,
          sortBy: {
            column: 'name',
            order: 'asc',
          },
        })

    if (error) throw error

    const rows = data || []

    for (const row of rows) {
      const objectPath =
        folder
          ? `${folder}/${row.name}`
          : row.name

      const isFolder =
        !row.id &&
        !row.metadata

      if (isFolder) {
        await listStorageFolder({
          bucket,
          folder: objectPath,
          output,
        })
      } else {
        output.push({
          bucket,
          object_path: objectPath,
          size: Number(
            row.metadata?.size || 0
          ),
        })
      }
    }

    if (rows.length < PAGE_SIZE) {
      break
    }

    offset += PAGE_SIZE
  }
}

async function supabaseStorageSummary() {
  const { data, error } =
    await supabase.storage
      .listBuckets()

  if (error) throw error

  const buckets = []

  for (const bucket of data || []) {
    const objects = []
    let scanError = null

    try {
      await listStorageFolder({
        bucket: bucket.id,
        output: objects,
      })
    } catch (error) {
      scanError = error.message
    }

    buckets.push({
      bucket_id: bucket.id,
      public: Boolean(bucket.public),
      object_count: objects.length,
      total_bytes:
        objects.reduce(
          (sum, object) =>
            sum +
            Number(object.size || 0),
          0
        ),
      scan_error: scanError,
    })
  }

  return buckets
}

async function safeReadMigrationRows() {
  try {
    const rows = []
    let from = 0

    while (true) {
      const { data, error } =
        await supabase
          .from('storage_migrations')
          .select('*')
          .range(
            from,
            from + PAGE_SIZE - 1
          )

      if (error) throw error

      const page = data || []
      rows.push(...page)

      if (page.length < PAGE_SIZE) {
        break
      }

      from += PAGE_SIZE
    }

    return {
      available: true,
      rows,
      error: null,
    }
  } catch (error) {
    return {
      available: false,
      rows: [],
      error: error.message,
    }
  }
}

async function verifyMigrationRecords(
  client,
  result
) {
  if (!result.available) {
    return {
      available: false,
      read_error: result.error,
      rows_checked: 0,
      verified_rows: 0,
      missing_r2_objects: 0,
      size_mismatches: 0,
      checksum_mismatches: 0,
      invalid_verified_rows: 0,
      records: [],
    }
  }

  const cache = new Map()
  const records = []

  for (const row of result.rows) {
    const key = clean(row.r2_key)

    if (!key) {
      records.push({
        migration_key:
          row.migration_key,
        status:
          row.status,
        r2_key: null,
        exists: false,
        issue:
          'MISSING_R2_KEY',
      })

      continue
    }

    if (!cache.has(key)) {
      cache.set(
        key,
        await headR2Object(
          client,
          key
        )
      )
    }

    const check = cache.get(key)
    const expectedSize =
      Number(row.file_size || 0)

    const expectedHash =
      clean(
        row.checksum_sha256
      )

    const sizeMismatch =
      check.exists &&
      expectedSize > 0 &&
      check.size !== expectedSize

    const checksumMismatch =
      check.exists &&
      expectedHash &&
      check.sha256 &&
      check.sha256 !== expectedHash

    const invalidVerified =
      clean(row.status) === 'verified' &&
      (
        !check.exists ||
        sizeMismatch ||
        checksumMismatch ||
        !row.verified_at
      )

    records.push({
      migration_key:
        row.migration_key,
      source_kind:
        row.source_kind,
      old_bucket:
        row.old_bucket,
      old_path:
        row.old_path,
      r2_key:
        key,
      status:
        row.status,
      verified_at:
        row.verified_at,
      delete_after:
        row.delete_after,
      deleted_at:
        row.deleted_at,
      expected_size:
        expectedSize || null,
      actual_size:
        check.size,
      expected_sha256:
        expectedHash || null,
      actual_sha256:
        check.sha256,
      exists:
        check.exists,
      size_mismatch:
        sizeMismatch,
      checksum_mismatch:
        checksumMismatch,
      invalid_verified:
        invalidVerified,
      head_error:
        check.error,
    })
  }

  return {
    available: true,
    read_error: null,
    rows_checked:
      records.length,
    verified_rows:
      records.filter(
        (row) =>
          row.status === 'verified'
      ).length,
    missing_r2_objects:
      records.filter(
        (row) =>
          !row.exists
      ).length,
    size_mismatches:
      records.filter(
        (row) =>
          row.size_mismatch
      ).length,
    checksum_mismatches:
      records.filter(
        (row) =>
          row.checksum_mismatch
      ).length,
    invalid_verified_rows:
      records.filter(
        (row) =>
          row.invalid_verified
      ).length,
    records,
  }
}

async function writeReport(report) {
  await fs.mkdir(
    OUTPUT_DIR,
    {
      recursive: true,
    }
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

  return reportPath
}

async function main() {
  requireConfig()

  const client = makeR2Client()
  const database =
    await scanDatabase()

  const r2ReferenceChecks =
    await verifyR2References(
      client,
      database.r2References
    )

  const migrationRows =
    await safeReadMigrationRows()

  const migrationVerification =
    await verifyMigrationRecords(
      client,
      migrationRows
    )

  const [
    r2Summary,
    storageBuckets,
  ] = await Promise.all([
    countR2Objects(client),
    supabaseStorageSummary(),
  ])

  const activeFindings =
    database.findings.filter(
      (finding) =>
        finding.blocking
    )

  const nonBlockingFindings =
    database.findings.filter(
      (finding) =>
        !finding.blocking
    )

  const activeSupabase =
    activeFindings.filter(
      (finding) =>
        finding.kind ===
        'SUPABASE_STORAGE_REFERENCE'
    )

  const activeInline =
    activeFindings.filter(
      (finding) =>
        finding.kind ===
          'INLINE_MEDIA_DATA' ||
        finding.kind ===
          'SUSPICIOUS_LARGE_MEDIA_STRING'
    )

  const missingActiveR2 =
    r2ReferenceChecks.filter(
      (row) =>
        row.blocking &&
        !row.exists
    )

  const tableReadErrors =
    database.tables.filter(
      (table) =>
        table.read_error
    )

  const storageScanErrors =
    storageBuckets.filter(
      (bucket) =>
        bucket.scan_error
    )

  const migrationRecordFailures =
    migrationVerification.available
      ? (
          migrationVerification
            .missing_r2_objects +
          migrationVerification
            .size_mismatches +
          migrationVerification
            .checksum_mismatches +
          migrationVerification
            .invalid_verified_rows
        )
      : 0

  const success =
    activeSupabase.length === 0 &&
    activeInline.length === 0 &&
    missingActiveR2.length === 0 &&
    tableReadErrors.length === 0 &&
    storageScanErrors.length === 0 &&
    migrationRecordFailures === 0

  const report = {
    generated_at:
      new Date().toISOString(),
    mode:
      'READ_ONLY_VERIFICATION',
    success,
    active_database: {
      schema_tables_discovered:
        database.definitions.length,
      tables_scanned:
        database.tables.length,
      table_read_errors:
        tableReadErrors.length,
      supabase_storage_references:
        activeSupabase.length,
      inline_media_references:
        activeInline.length,
      r2_references:
        database.r2References.filter(
          (row) => row.blocking
        ).length,
      missing_r2_objects:
        missingActiveR2.length,
    },
    non_blocking_backup_history: {
      findings:
        nonBlockingFindings.length,
      tables: [
        ...new Set(
          nonBlockingFindings.map(
            (finding) =>
              finding.table
          )
        ),
      ],
    },
    r2_bucket: {
      bucket: config.bucket,
      ...r2Summary,
    },
    supabase_storage: {
      total_objects:
        storageBuckets.reduce(
          (sum, bucket) =>
            sum +
            Number(
              bucket.object_count || 0
            ),
          0
        ),
      total_bytes:
        storageBuckets.reduce(
          (sum, bucket) =>
            sum +
            Number(
              bucket.total_bytes || 0
            ),
          0
        ),
      buckets: storageBuckets,
      note:
        'Supabase Storage objects may remain during the 30-day safety retention period and do not by themselves fail verification.',
    },
    migration_records:
      migrationVerification,
    table_scan_results:
      database.tables,
    active_findings:
      activeFindings,
    non_blocking_findings:
      nonBlockingFindings,
    missing_active_r2_objects:
      missingActiveR2,
    r2_reference_checks:
      r2ReferenceChecks,
  }

  const reportPath =
    await writeReport(report)

  console.log(
    JSON.stringify(
      {
        success:
          report.success,
        schema_tables_discovered:
          report.active_database
            .schema_tables_discovered,
        table_read_errors:
          report.active_database
            .table_read_errors,
        active_supabase_references:
          report.active_database
            .supabase_storage_references,
        active_inline_media:
          report.active_database
            .inline_media_references,
        active_r2_references:
          report.active_database
            .r2_references,
        missing_active_r2_objects:
          report.active_database
            .missing_r2_objects,
        non_blocking_backup_history_findings:
          report.non_blocking_backup_history
            .findings,
        supabase_storage_objects:
          report.supabase_storage
            .total_objects,
        r2_objects:
          report.r2_bucket
            .object_count,
        migration_table_available:
          report.migration_records
            .available,
        migration_record_failures:
          migrationRecordFailures,
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
    'FINAL STORAGE AUDIT FAILED'
  )
  console.error(error)
  process.exit(1)
})
