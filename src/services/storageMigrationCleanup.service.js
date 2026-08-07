import {
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { supabase } from '../config/supabase.js'

const PAGE_SIZE = 1000
const MIN_RETENTION_DAYS = 30
const DEFAULT_BATCH_SIZE = 100

const NON_ACTIVE_REFERENCE_TABLES = new Set([
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
  endpoint: env('CLOUDFLARE_R2_ENDPOINT'),
  supabaseUrl: env('SUPABASE_URL').replace(/\/+$/, ''),
  supabaseKey: env('SUPABASE_SERVICE_ROLE_KEY'),
}

function cleanupEnabled() {
  return (
    clean(
      process.env.STORAGE_MIGRATION_CLEANUP_ENABLED ||
        'true'
    ).toLowerCase() !== 'false'
  )
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

function retentionSatisfied(row, now) {
  const verifiedAt = new Date(row.verified_at).getTime()
  const deleteAfter = new Date(row.delete_after).getTime()
  const nowMs = now.getTime()

  if (
    !Number.isFinite(verifiedAt) ||
    !Number.isFinite(deleteAfter)
  ) {
    return false
  }

  const minimumDeleteTime =
    verifiedAt +
    MIN_RETENTION_DAYS *
      24 *
      60 *
      60 *
      1000

  return (
    deleteAfter <= nowMs &&
    minimumDeleteTime <= nowMs
  )
}

function parseSupabaseStorageUrl(value) {
  const input = clean(value)

  if (
    !input ||
    !input.toLowerCase().includes('supabase.co')
  ) {
    return null
  }

  let url

  try {
    url = new URL(input)
  } catch {
    return null
  }

  const markers = [
    '/storage/v1/object/',
    '/storage/v1/render/image/',
  ]

  let tail = ''

  for (const marker of markers) {
    const index = url.pathname.indexOf(marker)

    if (index >= 0) {
      tail = url.pathname.slice(
        index + marker.length
      )
      break
    }
  }

  if (!tail) return null

  const parts = tail.split('/')

  if (
    [
      'public',
      'sign',
      'authenticated',
    ].includes(parts[0])
  ) {
    parts.shift()
  }

  const bucket = decodeURIComponent(
    parts.shift() || ''
  )

  const objectPath = parts
    .map((part) => decodeURIComponent(part))
    .join('/')

  if (!bucket || !objectPath) {
    return null
  }

  return {
    bucket,
    path: objectPath,
  }
}

function storageKey(bucket, objectPath) {
  return `${clean(bucket)}::${clean(objectPath)}`
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

  if (schema.type) return schema.type
  if (schema.$ref) return 'object'

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
  const columns = Object.entries(properties)
    .filter(([, definition]) =>
      [
        'string',
        'object',
        'array',
      ].includes(propertyType(definition))
    )
    .map(([name]) => name)

  for (const key of [
    'id',
    'source_key',
    'order_id',
    'user_id',
  ]) {
    if (
      Object.prototype.hasOwnProperty.call(
        properties,
        key
      ) &&
      !columns.includes(key)
    ) {
      columns.push(key)
    }
  }

  return columns
}

async function discoverDatabaseSchema() {
  const response = await fetch(
    `${config.supabaseUrl}/rest/v1/`,
    {
      headers: {
        apikey: config.supabaseKey,
        Authorization:
          `Bearer ${config.supabaseKey}`,
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
    .filter(
      ([table]) =>
        !NON_ACTIVE_REFERENCE_TABLES.has(table)
    )
    .map(([table, schema]) => ({
      table,
      columns: candidateColumns(schema),
    }))
    .filter((item) => item.columns.length)
    .sort((a, b) =>
      a.table.localeCompare(b.table)
    )
}

async function readTableRows(table, columns) {
  const rows = []
  const select = columns.join(',')
  let from = 0

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

function rowIdentifier(row, index) {
  for (const key of [
    'id',
    'source_key',
    'order_id',
    'user_id',
  ]) {
    if (
      row[key] !== undefined &&
      row[key] !== null
    ) {
      return clean(row[key]) ||
        `row-${index + 1}`
    }
  }

  return `row-${index + 1}`
}

function buildCandidateLookups(candidates) {
  const byStorageObject = new Map()
  const byExactValue = new Map()

  for (const row of candidates) {
    const key = storageKey(
      row.old_bucket,
      row.old_path
    )

    if (!byStorageObject.has(key)) {
      byStorageObject.set(key, new Set())
    }

    byStorageObject
      .get(key)
      .add(row.migration_key)

    for (const value of [
      row.old_url,
      row.old_path,
      `${row.old_bucket}/${row.old_path}`,
    ]) {
      const input = clean(value)

      if (!input) continue

      if (!byExactValue.has(input)) {
        byExactValue.set(input, new Set())
      }

      byExactValue
        .get(input)
        .add(row.migration_key)
    }
  }

  return {
    byStorageObject,
    byExactValue,
  }
}

function addReference(
  references,
  migrationKey,
  location
) {
  if (!references.has(migrationKey)) {
    references.set(
      migrationKey,
      []
    )
  }

  const rows =
    references.get(migrationKey)

  if (rows.length < 20) {
    rows.push(location)
  }
}

function scanStringForReferences(
  value,
  location,
  lookups,
  references
) {
  const input = clean(value)

  if (!input) return

  const exact =
    lookups.byExactValue.get(input)

  if (exact) {
    for (const migrationKey of exact) {
      addReference(
        references,
        migrationKey,
        location
      )
    }
  }

  const parsed =
    parseSupabaseStorageUrl(input)

  if (!parsed) return

  const matches =
    lookups.byStorageObject.get(
      storageKey(
        parsed.bucket,
        parsed.path
      )
    )

  if (!matches) return

  for (const migrationKey of matches) {
    addReference(
      references,
      migrationKey,
      location
    )
  }
}

function scanValueForReferences({
  value,
  table,
  rowId,
  column,
  path,
  lookups,
  references,
}) {
  if (typeof value === 'string') {
    scanStringForReferences(
      value,
      {
        table,
        row_id: rowId,
        column,
        path,
      },
      lookups,
      references
    )

    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      scanValueForReferences({
        value: item,
        table,
        rowId,
        column,
        path: `${path}[${index}]`,
        lookups,
        references,
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
        scanValueForReferences({
          value: item,
          table,
          rowId,
          column,
          path: `${path}.${key}`,
          lookups,
          references,
        })
      }
    )
  }
}

async function findActiveReferences(candidates) {
  const definitions =
    await discoverDatabaseSchema()

  const lookups =
    buildCandidateLookups(candidates)

  const references = new Map()
  const errors = []

  for (const definition of definitions) {
    try {
      const rows =
        await readTableRows(
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

          scanValueForReferences({
            value: row[column],
            table: definition.table,
            rowId,
            column,
            path:
              `${definition.table}.${column}`,
            lookups,
            references,
          })
        }
      })
    } catch (error) {
      errors.push({
        table: definition.table,
        error: error.message,
      })
    }
  }

  return {
    references,
    errors,
    tables_scanned:
      definitions.length,
  }
}

async function headR2Object(
  client,
  row
) {
  try {
    const result = await client.send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: row.r2_key,
      })
    )

    const size =
      Number(
        result.ContentLength || 0
      )

    const hash =
      clean(
        result.Metadata?.sha256
      )

    const expectedSize =
      Number(
        row.file_size || 0
      )

    const expectedHash =
      clean(
        row.checksum_sha256
      )

    if (
      expectedSize > 0 &&
      size !== expectedSize
    ) {
      return {
        ok: false,
        reason:
          `R2 size mismatch: expected=${expectedSize}, actual=${size}`,
      }
    }

    if (
      expectedHash &&
      !hash
    ) {
      return {
        ok: false,
        reason:
          'R2 SHA-256 metadata is missing',
      }
    }

    if (
      expectedHash &&
      hash !== expectedHash
    ) {
      return {
        ok: false,
        reason:
          'R2 SHA-256 mismatch',
      }
    }

    return {
      ok: true,
      size,
      sha256: hash || null,
    }
  } catch (error) {
    return {
      ok: false,
      reason:
        `R2 object check failed: ${error.name || error.message}`,
    }
  }
}

async function sourceObjectExists(row) {
  const parts =
    clean(row.old_path)
      .split('/')

  const name =
    parts.pop() || ''

  const folder =
    parts.join('/')

  if (!name) {
    throw new Error(
      'Supabase source path is invalid'
    )
  }

  const { data, error } =
    await supabase.storage
      .from(row.old_bucket)
      .list(folder, {
        limit: 100,
        offset: 0,
        search: name,
      })

  if (error) throw error

  return (data || []).some(
    (item) =>
      item.name === name
  )
}

async function updateMigrationRow(
  row,
  patch
) {
  const now =
    new Date().toISOString()

  const { error } = await supabase
    .from('storage_migrations')
    .update({
      ...patch,
      updated_at: now,
    })
    .eq(
      'migration_key',
      row.migration_key
    )

  if (error) throw error
}

async function markAttempt(
  row,
  status,
  errorMessage = null,
  extra = {}
) {
  await updateMigrationRow(
    row,
    {
      status,
      cleanup_attempts:
        Number(
          row.cleanup_attempts || 0
        ) + 1,
      last_cleanup_attempt_at:
        new Date().toISOString(),
      last_cleanup_error:
        errorMessage,
      ...extra,
    }
  )
}

async function readDueCandidates(now) {
  const batchSize =
    Math.min(
      Math.max(
        Number(
          process.env
            .STORAGE_CLEANUP_BATCH_SIZE ||
            DEFAULT_BATCH_SIZE
        ),
        1
      ),
      1000
    )

  const { data, error } =
    await supabase
      .from('storage_migrations')
      .select('*')
      .eq(
        'source_kind',
        'supabase_storage'
      )
      .not(
        'verified_at',
        'is',
        null
      )
      .not(
        'delete_after',
        'is',
        null
      )
      .is(
        'deleted_at',
        null
      )
      .lte(
        'delete_after',
        now.toISOString()
      )
      .order(
        'delete_after',
        {
          ascending: true,
        }
      )
      .limit(batchSize)

  if (error) throw error

  return (data || []).filter(
    (row) =>
      retentionSatisfied(
        row,
        now
      )
  )
}

export async function runStorageMigrationCleanup() {
  if (!cleanupEnabled()) {
    return {
      enabled: false,
      scanned: 0,
      deleted: 0,
      blocked_active_reference: 0,
      blocked_r2_verification: 0,
      delete_failed: 0,
      message:
        'Storage migration cleanup is disabled',
    }
  }

  requireConfig()

  const now = new Date()
  const candidates =
    await readDueCandidates(now)

  if (!candidates.length) {
    return {
      enabled: true,
      scanned: 0,
      deleted: 0,
      blocked_active_reference: 0,
      blocked_r2_verification: 0,
      delete_failed: 0,
    }
  }

  const activeScan =
    await findActiveReferences(
      candidates
    )

  if (activeScan.errors.length) {
    return {
      enabled: true,
      scanned:
        candidates.length,
      deleted: 0,
      blocked_active_reference: 0,
      blocked_r2_verification: 0,
      delete_failed: 0,
      scan_failed: true,
      scan_errors:
        activeScan.errors,
      message:
        'Cleanup stopped because active-reference scanning was incomplete',
    }
  }

  const client =
    makeR2Client()

  const summary = {
    enabled: true,
    scanned:
      candidates.length,
    deleted: 0,
    already_absent: 0,
    blocked_active_reference: 0,
    blocked_r2_verification: 0,
    delete_failed: 0,
    tables_scanned:
      activeScan.tables_scanned,
    results: [],
  }

  for (const row of candidates) {
    const references =
      activeScan.references.get(
        row.migration_key
      ) || []

    if (references.length) {
      const message =
        `Active database reference still exists (${references.length})`

      await markAttempt(
        row,
        'blocked_active_reference',
        message
      )

      summary
        .blocked_active_reference +=
        1

      summary.results.push({
        migration_key:
          row.migration_key,
        status:
          'BLOCKED_ACTIVE_REFERENCE',
        references,
      })

      continue
    }

    const r2Check =
      await headR2Object(
        client,
        row
      )

    if (!r2Check.ok) {
      await markAttempt(
        row,
        'blocked_r2_verification',
        r2Check.reason
      )

      summary
        .blocked_r2_verification +=
        1

      summary.results.push({
        migration_key:
          row.migration_key,
        status:
          'BLOCKED_R2_VERIFICATION',
        error:
          r2Check.reason,
      })

      continue
    }

    try {
      const exists =
        await sourceObjectExists(
          row
        )

      if (!exists) {
        const deletedAt =
          new Date().toISOString()

        await markAttempt(
          row,
          'deleted',
          null,
          {
            deleted_at:
              deletedAt,
          }
        )

        summary.deleted += 1
        summary.already_absent += 1

        summary.results.push({
          migration_key:
            row.migration_key,
          status:
            'ALREADY_ABSENT',
        })

        continue
      }

      await markAttempt(
        row,
        'delete_pending',
        null
      )

      const {
        error: removeError,
      } =
        await supabase.storage
          .from(
            row.old_bucket
          )
          .remove([
            row.old_path,
          ])

      if (removeError) {
        throw removeError
      }

      const stillExists =
        await sourceObjectExists(
          row
        )

      if (stillExists) {
        throw new Error(
          'Supabase Storage source still exists after remove()'
        )
      }

      const deletedAt =
        new Date().toISOString()

      await updateMigrationRow(
        row,
        {
          status:
            'deleted',
          deleted_at:
            deletedAt,
          last_cleanup_error:
            null,
        }
      )

      summary.deleted += 1

      summary.results.push({
        migration_key:
          row.migration_key,
        status:
          'DELETED',
      })
    } catch (error) {
      await markAttempt(
        row,
        'delete_failed',
        error.message
      )

      summary.delete_failed +=
        1

      summary.results.push({
        migration_key:
          row.migration_key,
        status:
          'DELETE_FAILED',
        error:
          error.message,
      })
    }
  }

  return summary
}
