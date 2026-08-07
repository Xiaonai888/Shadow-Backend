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

const APPLY_CONFIRM_VALUE =
  'MIGRATE_ALL_SUPABASE_MEDIA_TO_R2'
const PAGE_SIZE = 1000
const OUTPUT_DIR = path.resolve(
  process.cwd(),
  'storage-migration-output'
)

const TARGETS = [
  {
    table: 'author_page_notifications',
    columns: ['metadata'],
  },
  {
    table: 'author_page_posts',
    columns: ['image_urls'],
  },
  {
    table: 'notifications',
    columns: ['image_url'],
  },
  {
    table: 'reader_mails',
    columns: ['image_url'],
  },
  {
    table: 'shadow_advertisements',
    columns: ['image_url'],
  },
]

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
  mode: clean(
    process.env.MIGRATION_MODE || 'dry-run'
  ).toLowerCase(),
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
}

function isApplyMode() {
  return config.mode === 'apply'
}

function requireApplyConfig() {
  if (!isApplyMode()) return

  const missing = []

  if (!config.accountId) missing.push('R2_ACCOUNT_ID')
  if (!config.accessKeyId) missing.push('R2_ACCESS_KEY_ID')
  if (!config.secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY')
  if (!config.bucket) missing.push('R2_BUCKET_NAME')
  if (!config.publicUrl) missing.push('R2_PUBLIC_URL')

  if (missing.length) {
    throw new Error(
      `Missing environment: ${missing.join(', ')}`
    )
  }

  if (
    clean(process.env.MIGRATION_CONFIRM) !==
    APPLY_CONFIRM_VALUE
  ) {
    throw new Error(
      `Apply mode requires MIGRATION_CONFIRM=${APPLY_CONFIRM_VALUE}`
    )
  }
}

function makeR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint:
      config.endpoint ||
      `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(value)
    .digest('hex')
}

function safePart(value, fallback = 'file') {
  const output = clean(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140)

  return output || fallback
}

function missingRelation(error) {
  const message = clean(error?.message).toLowerCase()

  return (
    error?.code === 'PGRST205' ||
    error?.code === '42P01' ||
    message.includes('could not find the table') ||
    (
      message.includes('relation') &&
      message.includes('does not exist')
    )
  )
}

async function readAllRows(
  tableName,
  { optional = false } = {}
) {
  const rows = []
  let from = 0

  while (true) {
    const { data, error } = await supabase
      .from(tableName)
      .select('*')
      .range(from, from + PAGE_SIZE - 1)

    if (error) {
      if (optional && missingRelation(error)) {
        return null
      }

      throw error
    }

    const page = data || []
    rows.push(...page)

    if (page.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return rows
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

function parseSupabaseStorageUrl(value) {
  const input = clean(value)

  if (!isSupabaseStorageUrl(input)) {
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

function storageMapKey(bucket, objectPath) {
  return `${bucket}::${objectPath}`
}

function isInlineMediaValue(value) {
  const input = clean(value).toLowerCase()

  return (
    input.startsWith('data:') ||
    input.startsWith('base64,') ||
    input.includes(';base64,')
  )
}

function contentTypeFromBuffer(
  buffer,
  fallback = ''
) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([
        137, 80, 78, 71,
        13, 10, 26, 10,
      ])
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
    buffer.subarray(0, 4).toString('ascii') ===
      'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') ===
      'WEBP'
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

  return (
    clean(fallback).split(';')[0] ||
    'application/octet-stream'
  )
}

function extensionFromMime(value) {
  const type = clean(value)
    .toLowerCase()
    .split(';')[0]

  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
  }

  return map[type] || ''
}

function mediaFieldName(value) {
  const key = clean(value).replace(
    /[A-Z]/g,
    (match) => `_${match.toLowerCase()}`
  )

  return /(^|_)(image|img|avatar|cover|thumbnail|proof|qr|audio|video|pdf|attachment|file|media)($|_)/i.test(
    key
  )
}

function decodeInlineMedia(
  value,
  allowBareBase64 = false
) {
  const input = clean(value)

  if (!input) return null

  let contentType = ''
  let encoded = ''

  const dataMatch = input.match(
    /^data:([^;,]+);base64,([\s\S]+)$/i
  )

  if (dataMatch) {
    contentType = clean(dataMatch[1])
    encoded = dataMatch[2]
  } else if (
    input.toLowerCase().startsWith('base64,')
  ) {
    encoded = input.slice(7)
  } else if (
    allowBareBase64 &&
    input.length >= 128 &&
    /^[a-z0-9+/=\s]+$/i.test(input)
  ) {
    encoded = input
  } else {
    return null
  }

  const normalized = encoded.replace(/\s+/g, '')
  const buffer = Buffer.from(normalized, 'base64')

  if (!buffer.length) return null

  contentType = contentTypeFromBuffer(
    buffer,
    contentType
  )

  if (
    contentType ===
      'application/octet-stream' &&
    !dataMatch
  ) {
    return null
  }

  const extension =
    extensionFromMime(contentType)

  if (!extension) return null

  return {
    buffer,
    contentType,
    extension,
    size: buffer.length,
    sha256: sha256(buffer),
  }
}

async function ensureMigrationTable() {
  if (!isApplyMode()) return

  const { error } = await supabase
    .from('storage_migrations')
    .select('migration_key')
    .limit(1)

  if (error) {
    throw new Error(
      'storage_migrations is not ready. Apply scripts/storageMigrationSetup.sql first.'
    )
  }
}

async function loadStorageMapping() {
  if (!isApplyMode()) return new Map()

  const rows = await readAllRows(
    'storage_migrations'
  )

  const mapping = new Map()

  for (const row of rows) {
    if (
      row.source_kind !==
        'supabase_storage' ||
      !row.old_bucket ||
      !row.old_path ||
      !row.r2_key ||
      !row.r2_url ||
      !row.verified_at
    ) {
      continue
    }

    mapping.set(
      storageMapKey(
        row.old_bucket,
        row.old_path
      ),
      row
    )
  }

  return mapping
}

async function verifyMappedR2(
  client,
  record
) {
  try {
    const head = await client.send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: record.r2_key,
      })
    )

    const size = Number(
      head.ContentLength || 0
    )
    const expectedSize = Number(
      record.file_size || 0
    )

    if (
      expectedSize > 0 &&
      size !== expectedSize
    ) {
      return false
    }

    const expectedHash = clean(
      record.checksum_sha256
    )
    const actualHash = clean(
      head.Metadata?.sha256
    )

    if (
      expectedHash &&
      actualHash !== expectedHash
    ) {
      return false
    }

    return true
  } catch {
    return false
  }
}

async function uploadInlineMedia({
  client,
  file,
  table,
  rowId,
  column,
  pathLabel,
}) {
  const migrationKey = sha256(
    [
      'inline_media',
      table,
      rowId,
      column,
      pathLabel,
      file.sha256,
    ].join(':')
  )

  const { data: existing, error } =
    await supabase
      .from('storage_migrations')
      .select('*')
      .eq('migration_key', migrationKey)
      .maybeSingle()

  if (error) throw error

  if (
    existing?.r2_key &&
    existing?.r2_url &&
    await verifyMappedR2(
      client,
      existing
    )
  ) {
    return existing.r2_url
  }

  const key = [
    'inline-migration',
    safePart(table),
    safePart(rowId, 'row'),
    `${safePart(column)}-${sha256(pathLabel).slice(0, 8)}-${file.sha256.slice(0, 16)}.${file.extension}`,
  ].join('/')

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.contentType,
      CacheControl:
        'public, max-age=31536000, immutable',
      Metadata: {
        sha256: file.sha256,
        migrated_from: 'inline-media',
      },
    })
  )

  const head = await client.send(
    new HeadObjectCommand({
      Bucket: config.bucket,
      Key: key,
    })
  )

  if (
    Number(head.ContentLength || 0) !==
    file.size
  ) {
    throw new Error(
      'R2 inline media size verification failed'
    )
  }

  if (
    clean(head.Metadata?.sha256) !==
    file.sha256
  ) {
    throw new Error(
      'R2 inline media checksum verification failed'
    )
  }

  const r2Url =
    `${config.publicUrl}/${key}`
  const now = new Date().toISOString()

  const { error: recordError } =
    await supabase
      .from('storage_migrations')
      .upsert(
        {
          migration_key: migrationKey,
          source_kind: 'inline_media',
          old_bucket: null,
          old_path:
            `inline:${table}:${rowId}:${column}:${pathLabel}`,
          old_url: null,
          source_table: table,
          source_row_id: clean(rowId) || null,
          source_column: column,
          r2_key: key,
          r2_url: r2Url,
          file_size: file.size,
          checksum_sha256: file.sha256,
          migrated_at: now,
          verified_at: now,
          delete_after: null,
          deleted_at: null,
          status: 'verified',
        },
        {
          onConflict: 'migration_key',
        }
      )

  if (recordError) throw recordError

  return r2Url
}

async function transformValue({
  value,
  client,
  table,
  rowId,
  column,
  pathLabel,
  fieldName,
  storageMapping,
}) {
  if (typeof value === 'string') {
    const input = clean(value)

    if (!input) {
      return {
        value,
        changed: false,
      }
    }

    if (isSupabaseStorageUrl(input)) {
      const parsed =
        parseSupabaseStorageUrl(input)

      if (!parsed) {
        throw new Error(
          'Unable to parse Supabase Storage URL'
        )
      }

      const record = storageMapping.get(
        storageMapKey(
          parsed.bucket,
          parsed.path
        )
      )

      if (!record) {
        throw new Error(
          `Missing verified storage migration record: ${parsed.bucket}/${parsed.path}`
        )
      }

      if (
        !await verifyMappedR2(
          client,
          record
        )
      ) {
        throw new Error(
          `R2 verification failed: ${record.r2_key}`
        )
      }

      return {
        value: record.r2_url,
        changed: record.r2_url !== input,
      }
    }

    const inlineFile =
      decodeInlineMedia(
        input,
        mediaFieldName(fieldName)
      )

    if (inlineFile) {
      const r2Url =
        await uploadInlineMedia({
          client,
          file: inlineFile,
          table,
          rowId,
          column,
          pathLabel,
        })

      return {
        value: r2Url,
        changed: true,
      }
    }

    return {
      value,
      changed: false,
    }
  }

  if (Array.isArray(value)) {
    const output = []
    let changed = false

    for (
      let index = 0;
      index < value.length;
      index += 1
    ) {
      const result =
        await transformValue({
          value: value[index],
          client,
          table,
          rowId,
          column,
          pathLabel:
            `${pathLabel}[${index}]`,
          fieldName,
          storageMapping,
        })

      output.push(result.value)
      changed =
        changed || result.changed
    }

    return {
      value: changed ? output : value,
      changed,
    }
  }

  if (
    value &&
    typeof value === 'object'
  ) {
    const output = { ...value }
    let changed = false

    for (
      const [key, item] of
      Object.entries(value)
    ) {
      const result =
        await transformValue({
          value: item,
          client,
          table,
          rowId,
          column,
          pathLabel:
            `${pathLabel}.${key}`,
          fieldName: key,
          storageMapping,
        })

      if (result.changed) {
        output[key] = result.value
        changed = true
      }
    }

    return {
      value: changed ? output : value,
      changed,
    }
  }

  return {
    value,
    changed: false,
  }
}

function countCandidates(
  value,
  result = {
    supabase_storage: 0,
    inline_media: 0,
  }
) {
  if (typeof value === 'string') {
    if (isSupabaseStorageUrl(value)) {
      result.supabase_storage += 1
    }

    if (isInlineMediaValue(value)) {
      result.inline_media += 1
    }

    return result
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      countCandidates(item, result)
    }

    return result
  }

  if (
    value &&
    typeof value === 'object'
  ) {
    for (
      const item of Object.values(value)
    ) {
      countCandidates(item, result)
    }
  }

  return result
}

async function inventoryTargets() {
  const tables = []
  let total = 0

  for (const target of TARGETS) {
    const rows = await readAllRows(
      target.table,
      { optional: true }
    )

    if (rows === null) {
      tables.push({
        table: target.table,
        status: 'TABLE_NOT_PRESENT',
      })
      continue
    }

    const counts = {
      supabase_storage: 0,
      inline_media: 0,
    }

    for (const row of rows) {
      for (const column of target.columns) {
        if (
          !Object.prototype
            .hasOwnProperty.call(
              row,
              column
            )
        ) {
          continue
        }

        countCandidates(
          row[column],
          counts
        )
      }
    }

    const candidates =
      counts.supabase_storage +
      counts.inline_media

    total += candidates

    tables.push({
      table: target.table,
      rows: rows.length,
      ...counts,
      candidates,
    })
  }

  return {
    total,
    tables,
  }
}

async function migrateTargets({
  client,
  storageMapping,
}) {
  const results = []

  for (const target of TARGETS) {
    const rows = await readAllRows(
      target.table,
      { optional: true }
    )

    if (rows === null) {
      results.push({
        table: target.table,
        status: 'TABLE_NOT_PRESENT',
      })
      continue
    }

    let updatedRows = 0
    let failedRows = 0

    for (const row of rows) {
      const rowId = row.id
      const patch = {}

      try {
        for (const column of target.columns) {
          if (
            !Object.prototype
              .hasOwnProperty.call(
                row,
                column
              )
          ) {
            continue
          }

          const result =
            await transformValue({
              value: row[column],
              client,
              table: target.table,
              rowId,
              column,
              pathLabel:
                `${target.table}.${column}`,
              fieldName: column,
              storageMapping,
            })

          if (result.changed) {
            patch[column] = result.value
          }
        }

        if (!Object.keys(patch).length) {
          continue
        }

        if (
          row.id === undefined ||
          row.id === null
        ) {
          throw new Error(
            'Row has media to migrate but no id column'
          )
        }

        if (
          Object.prototype
            .hasOwnProperty.call(
              row,
              'updated_at'
            )
        ) {
          patch.updated_at =
            new Date().toISOString()
        }

        const { error } = await supabase
          .from(target.table)
          .update(patch)
          .eq('id', row.id)

        if (error) throw error
        updatedRows += 1
      } catch (error) {
        failedRows += 1

        console.error(
          `${target.table} row ${rowId} failed: ${error.message}`
        )
      }
    }

    results.push({
      table: target.table,
      status:
        failedRows > 0
          ? 'PARTIAL'
          : 'OK',
      updated_rows: updatedRows,
      failed_rows: failedRows,
    })
  }

  return results
}

async function writeReport(report) {
  await fs.mkdir(
    OUTPUT_DIR,
    { recursive: true }
  )

  const reportPath = path.join(
    OUTPUT_DIR,
    isApplyMode()
      ? 'additional-active-media-apply.json'
      : 'additional-active-media-dry-run.json'
  )

  await fs.writeFile(
    reportPath,
    JSON.stringify(report, null, 2),
    'utf8'
  )

  return reportPath
}

async function main() {
  requireApplyConfig()

  const before = await inventoryTargets()

  if (!isApplyMode()) {
    const report = {
      generated_at:
        new Date().toISOString(),
      mode: 'DRY_RUN',
      active_candidates: before,
      source_deletion: 'NOT_PERFORMED',
      note:
        'Dry run only. No R2 upload, database update, or Supabase deletion was performed.',
    }

    const reportPath =
      await writeReport(report)

    console.log(
      JSON.stringify(
        {
          mode: report.mode,
          candidates:
            report.active_candidates.total,
          source_deletion:
            report.source_deletion,
          report: reportPath,
        },
        null,
        2
      )
    )

    return
  }

  await ensureMigrationTable()

  const client = makeR2Client()
  const storageMapping =
    await loadStorageMapping()

  const results = await migrateTargets({
    client,
    storageMapping,
  })

  const after = await inventoryTargets()

  const failedRows = results.reduce(
    (total, item) =>
      total +
      Number(item.failed_rows || 0),
    0
  )

  const success =
    failedRows === 0 &&
    after.total === 0

  const report = {
    generated_at:
      new Date().toISOString(),
    mode:
      'APPLY_WITHOUT_SOURCE_DELETE',
    before,
    results,
    remaining_active_candidates: after,
    success,
    source_deletion: 'NOT_PERFORMED',
  }

  const reportPath =
    await writeReport(report)

  console.log(
    JSON.stringify(
      {
        mode: report.mode,
        failed_rows: failedRows,
        remaining:
          after.total,
        success,
        source_deletion:
          report.source_deletion,
        report: reportPath,
      },
      null,
      2
    )
  )

  if (!success) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(
    'ADDITIONAL ACTIVE MEDIA MIGRATION FAILED'
  )
  console.error(error)
  process.exit(1)
})
