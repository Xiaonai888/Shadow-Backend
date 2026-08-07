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
const RETENTION_DAYS = 30
const PAGE_SIZE = 1000
const OUTPUT_DIR = path.resolve(
  process.cwd(),
  'storage-migration-output'
)

const ACTIVE_TARGETS = [
  {
    table: 'users',
    columns: ['avatar_url'],
  },
  {
    table: 'author_pages',
    columns: ['avatar_url', 'cover_url'],
  },
  {
    table: 'stories',
    columns: [
      'cover_url',
      'landscape_thumbnail_url',
    ],
  },
  {
    table: 'story_carousel_slides',
    columns: ['image_url'],
  },
  {
    table: 'episodes',
    columns: ['cover_url', 'content'],
  },
  {
    table: 'episode_pages',
    columns: ['image_url'],
  },
  {
    table: 'author_payment_methods',
    columns: ['qr_image_url'],
  },
  {
    table: 'author_story_notifications',
    columns: ['metadata'],
  },
  {
    table: 'author_gift_ledger',
    columns: [
      'reader_avatar_url',
      'gift_image_path',
    ],
  },
  {
    table: 'payment_transactions',
    columns: [
      'qr_image',
      'proof_image_url',
      'aba_payload',
      'callback_payload',
    ],
  },
  {
    table: 'shadow_mall_orders',
    columns: [
      'items',
      'qr_image',
      'aba_payload',
      'callback_payload',
    ],
  },
  {
    table: 'shadow_mall_products',
    columns: [
      'cover_url',
      'image_url',
      'gallery',
      'gallery_images',
    ],
  },
  {
    table: 'purchase_requests',
    columns: ['proof_url'],
  },
  {
    table: 'ads',
    columns: ['image_url'],
  },
]

function clean(value) {
  return String(value ?? '').trim()
}

function env(...names) {
  for (const name of names) {
    const value = clean(
      process.env[name]
    )

    if (value) return value
  }

  return ''
}

const config = {
  mode:
    clean(
      process.env.MIGRATION_MODE ||
        'dry-run'
    ).toLowerCase(),
  accountId:
    env('R2_ACCOUNT_ID'),
  accessKeyId:
    env(
      'CLOUDFLARE_R2_ACCESS_KEY_ID',
      'R2_ACCESS_KEY_ID'
    ),
  secretAccessKey:
    env(
      'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
      'R2_SECRET_ACCESS_KEY'
    ),
  bucket:
    env(
      'CLOUDFLARE_R2_BUCKET',
      'R2_BUCKET_NAME'
    ),
  publicUrl:
    env(
      'CLOUDFLARE_R2_PUBLIC_URL',
      'R2_PUBLIC_URL'
    ).replace(/\/+$/, ''),
  endpoint:
    env(
      'CLOUDFLARE_R2_ENDPOINT'
    ),
  supabaseUrl:
    env('SUPABASE_URL')
      .replace(/\/+$/, ''),
}

function isApplyMode() {
  return config.mode === 'apply'
}

function requireApplyConfig() {
  if (!isApplyMode()) return

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

  if (!config.supabaseUrl) {
    missing.push('SUPABASE_URL')
  }

  if (missing.length) {
    throw new Error(
      `Missing environment: ${missing.join(', ')}`
    )
  }

  if (
    clean(
      process.env.MIGRATION_CONFIRM
    ) !== APPLY_CONFIRM_VALUE
  ) {
    throw new Error(
      `Apply mode requires MIGRATION_CONFIRM=${APPLY_CONFIRM_VALUE}`
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

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(value)
    .digest('hex')
}

function safePart(
  value,
  fallback = 'file'
) {
  const output = clean(value)
    .replace(
      /[^a-zA-Z0-9._-]+/g,
      '-'
    )
    .replace(/^-+|-+$/g, '')
    .slice(0, 140)

  return output || fallback
}

function safePath(value) {
  return clean(value)
    .split('/')
    .filter(Boolean)
    .map((part) =>
      safePart(part)
    )
    .join('/')
}

function sourceName(value) {
  const input = clean(value)

  if (!input) return 'file'

  try {
    const pathname =
      new URL(input).pathname

    return decodeURIComponent(
      pathname
        .split('/')
        .pop() ||
        'file'
    )
  } catch {
    return input
      .split('/')
      .pop() ||
      'file'
  }
}

function extensionFrom({
  name = '',
  contentType = '',
}) {
  const fileName =
    sourceName(name)

  const fromName =
    fileName
      .split('.')
      .pop()
      .toLowerCase()
      .replace(
        /[^a-z0-9]/g,
        ''
      )

  if (
    fromName &&
    fromName !==
      fileName.toLowerCase() &&
    fromName.length <= 8
  ) {
    return fromName === 'jpeg'
      ? 'jpg'
      : fromName
  }

  const type =
    clean(contentType)
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

  return (
    map[type] ||
    'bin'
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
    buffer
      .subarray(0, 4)
      .toString('ascii') === 'RIFF' &&
    buffer
      .subarray(8, 12)
      .toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }

  if (
    buffer.length >= 6 &&
    ['GIF87a', 'GIF89a'].includes(
      buffer
        .subarray(0, 6)
        .toString('ascii')
    )
  ) {
    return 'image/gif'
  }

  if (
    buffer.length >= 5 &&
    buffer
      .subarray(0, 5)
      .toString('ascii') === '%PDF-'
  ) {
    return 'application/pdf'
  }

  return (
    clean(fallback)
      .split(';')[0] ||
    'application/octet-stream'
  )
}

function isInlineMediaValue(value) {
  const input =
    clean(value)
      .toLowerCase()

  return (
    input.startsWith('data:') ||
    input.startsWith('base64,') ||
    input.includes(';base64,')
  )
}

function isSupabaseStorageUrl(value) {
  const input =
    clean(value)
      .toLowerCase()

  return (
    input.includes('supabase.co') &&
    (
      input.includes(
        '/storage/v1/object/'
      ) ||
      input.includes(
        '/storage/v1/render/image/'
      )
    )
  )
}

function parseSupabaseStorageUrl(value) {
  const input = clean(value)

  if (
    !isSupabaseStorageUrl(
      input
    )
  ) {
    return null
  }

  let url

  try {
    url = new URL(input)
  } catch {
    return null
  }

  const paths = [
    '/storage/v1/object/',
    '/storage/v1/render/image/',
  ]

  let tail = ''

  for (const marker of paths) {
    const index =
      url.pathname.indexOf(
        marker
      )

    if (index >= 0) {
      tail =
        url.pathname.slice(
          index +
            marker.length
        )
      break
    }
  }

  if (!tail) return null

  const parts =
    tail.split('/')

  if (
    [
      'public',
      'sign',
      'authenticated',
    ].includes(parts[0])
  ) {
    parts.shift()
  }

  const bucket =
    decodeURIComponent(
      parts.shift() || ''
    )

  const objectPath =
    parts
      .map((part) =>
        decodeURIComponent(part)
      )
      .join('/')

  if (
    !bucket ||
    !objectPath
  ) {
    return null
  }

  return {
    bucket,
    path: objectPath,
  }
}

function storageMapKey(
  bucket,
  objectPath
) {
  return `${bucket}::${objectPath}`
}

function canonicalSourceUrl(
  bucket,
  objectPath
) {
  if (!config.supabaseUrl) {
    return null
  }

  return (
    `${config.supabaseUrl}` +
    '/storage/v1/object/public/' +
    `${encodeURIComponent(bucket)}/` +
    objectPath
      .split('/')
      .map(encodeURIComponent)
      .join('/')
  )
}

function missingRelation(error) {
  const message =
    clean(error?.message)
      .toLowerCase()

  return (
    error?.code === 'PGRST205' ||
    error?.code === '42P01' ||
    message.includes(
      'could not find the table'
    ) ||
    message.includes(
      'relation'
    ) &&
    message.includes(
      'does not exist'
    )
  )
}

async function readAllRows(
  tableName,
  {
    optional = false,
  } = {}
) {
  const rows = []
  let from = 0

  while (true) {
    const {
      data,
      error,
    } = await supabase
      .from(tableName)
      .select('*')
      .range(
        from,
        from +
          PAGE_SIZE -
          1
      )

    if (error) {
      if (
        optional &&
        missingRelation(error)
      ) {
        return null
      }

      throw error
    }

    const page =
      data || []

    rows.push(...page)

    if (
      page.length <
      PAGE_SIZE
    ) {
      break
    }

    from += PAGE_SIZE
  }

  return rows
}

async function ensureMigrationTable() {
  if (!isApplyMode()) return

  const { error } =
    await supabase
      .from(
        'storage_migrations'
      )
      .select(
        'migration_key'
      )
      .limit(1)

  if (error) {
    throw new Error(
      'storage_migrations is not ready. Apply scripts/storageMigrationSetup.sql before running migration apply mode.'
    )
  }
}

async function listBucketObjects(
  bucketId,
  prefix = ''
) {
  const objects = []
  let offset = 0

  while (true) {
    const {
      data,
      error,
    } = await supabase
      .storage
      .from(bucketId)
      .list(prefix, {
        limit: PAGE_SIZE,
        offset,
        sortBy: {
          column: 'name',
          order: 'asc',
        },
      })

    if (error) {
      throw error
    }

    const page =
      data || []

    for (const item of page) {
      const fullPath =
        prefix
          ? `${prefix}/${item.name}`
          : item.name

      const isFolder =
        !item.id &&
        !item.metadata

      if (isFolder) {
        const nested =
          await listBucketObjects(
            bucketId,
            fullPath
          )

        objects.push(
          ...nested
        )
      } else {
        objects.push({
          bucket:
            bucketId,
          path:
            fullPath,
          metadata:
            item.metadata ||
            {},
        })
      }
    }

    if (
      page.length <
      PAGE_SIZE
    ) {
      break
    }

    offset += PAGE_SIZE
  }

  return objects
}

async function inventoryStorage() {
  const {
    data: buckets,
    error,
  } = await supabase
    .storage
    .listBuckets()

  if (error) throw error

  const output = []

  for (const bucket of buckets || []) {
    const objects =
      await listBucketObjects(
        bucket.id
      )

    output.push({
      bucket:
        bucket.id,
      public:
        Boolean(bucket.public),
      objects,
    })
  }

  return output
}

function countValueCandidates(
  value,
  result = {
    supabase_storage: 0,
    inline_media: 0,
  }
) {
  if (typeof value === 'string') {
    if (
      isSupabaseStorageUrl(
        value
      )
    ) {
      result.supabase_storage +=
        1
    }

    if (
      isInlineMediaValue(
        value
      )
    ) {
      result.inline_media +=
        1
    }

    return result
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      countValueCandidates(
        item,
        result
      )
    }

    return result
  }

  if (
    value &&
    typeof value === 'object'
  ) {
    for (
      const item of
      Object.values(value)
    ) {
      countValueCandidates(
        item,
        result
      )
    }
  }

  return result
}

async function inventoryDatabase() {
  const tables = []
  let storageReferences = 0
  let inlineMedia = 0

  for (const target of ACTIVE_TARGETS) {
    const rows =
      await readAllRows(
        target.table,
        {
          optional: true,
        }
      )

    if (rows === null) {
      tables.push({
        table:
          target.table,
        status:
          'TABLE_NOT_PRESENT',
      })
      continue
    }

    const counts = {
      supabase_storage: 0,
      inline_media: 0,
    }

    for (const row of rows) {
      for (
        const column of
        target.columns
      ) {
        if (
          !Object.prototype
            .hasOwnProperty
            .call(
              row,
              column
            )
        ) {
          continue
        }

        countValueCandidates(
          row[column],
          counts
        )
      }
    }

    storageReferences +=
      counts.supabase_storage

    inlineMedia +=
      counts.inline_media

    tables.push({
      table:
        target.table,
      rows:
        rows.length,
      ...counts,
    })
  }

  return {
    storage_references:
      storageReferences,
    inline_media:
      inlineMedia,
    total:
      storageReferences +
      inlineMedia,
    tables,
  }
}

async function readStorageObject({
  bucket,
  path: objectPath,
  metadata = {},
}) {
  const {
    data,
    error,
  } = await supabase
    .storage
    .from(bucket)
    .download(objectPath)

  if (error) throw error

  const buffer =
    Buffer.from(
      await data.arrayBuffer()
    )

  if (!buffer.length) {
    throw new Error(
      'Supabase Storage object is empty'
    )
  }

  const contentType =
    contentTypeFromBuffer(
      buffer,
      data.type ||
        metadata.mimetype ||
        metadata.contentType ||
        ''
    )

  return {
    buffer,
    contentType,
    size:
      buffer.length,
    sha256:
      sha256(buffer),
  }
}

function buildStorageR2Key({
  bucket,
  objectPath,
  file,
}) {
  const original =
    sourceName(objectPath)

  const extension =
    extensionFrom({
      name: original,
      contentType:
        file.contentType,
    })

  const base =
    safePart(
      original
        .replace(
          /\.[^.]+$/,
          ''
        ),
      'file'
    )

  const directory =
    safePath(
      objectPath
        .split('/')
        .slice(0, -1)
        .join('/')
    )

  const name =
    `${base}-${file.sha256.slice(0, 16)}.${extension}`

  return [
    'legacy-supabase',
    safePart(bucket),
    directory,
    name,
  ]
    .filter(Boolean)
    .join('/')
}

async function uploadAndVerify({
  client,
  key,
  file,
  sourceKind,
}) {
  await client.send(
    new PutObjectCommand({
      Bucket:
        config.bucket,
      Key: key,
      Body:
        file.buffer,
      ContentType:
        file.contentType,
      CacheControl:
        'public, max-age=31536000, immutable',
      Metadata: {
        sha256:
          file.sha256,
        migrated_from:
          sourceKind,
      },
    })
  )

  const head =
    await client.send(
      new HeadObjectCommand({
        Bucket:
          config.bucket,
        Key:
          key,
      })
    )

  const r2Size =
    Number(
      head.ContentLength ||
        0
    )

  const r2Hash =
    clean(
      head.Metadata?.sha256
    )

  if (
    r2Size !== file.size
  ) {
    throw new Error(
      `R2 size mismatch: source=${file.size}, r2=${r2Size}`
    )
  }

  if (
    r2Hash &&
    r2Hash !==
      file.sha256
  ) {
    throw new Error(
      'R2 SHA-256 mismatch'
    )
  }

  return {
    size:
      r2Size,
    sha256:
      r2Hash ||
      file.sha256,
    etag:
      clean(
        head.ETag
      ).replace(
        /^"|"$/g,
        ''
      ),
  }
}

async function verifyExistingR2({
  client,
  key,
  fileSize,
  checksum,
}) {
  try {
    const head =
      await client.send(
        new HeadObjectCommand({
          Bucket:
            config.bucket,
          Key:
            key,
        })
      )

    const size =
      Number(
        head.ContentLength ||
          0
      )

    const hash =
      clean(
        head.Metadata?.sha256
      )

    if (
      Number(fileSize || 0) > 0 &&
      size !==
        Number(fileSize)
    ) {
      return false
    }

    if (
      checksum &&
      hash &&
      hash !== checksum
    ) {
      return false
    }

    return true
  } catch {
    return false
  }
}

function addDaysIso(
  iso,
  days
) {
  return new Date(
    new Date(iso).getTime() +
      days *
        24 *
        60 *
        60 *
        1000
  ).toISOString()
}

async function upsertMigrationRecord(
  record
) {
  const {
    error,
  } = await supabase
    .from(
      'storage_migrations'
    )
    .upsert(
      record,
      {
        onConflict:
          'migration_key',
      }
    )

  if (error) throw error
}

async function loadMigrationRecords() {
  if (!isApplyMode()) {
    return new Map()
  }

  const rows =
    await readAllRows(
      'storage_migrations'
    )

  return new Map(
    rows.map((row) => [
      row.migration_key,
      row,
    ])
  )
}

function storageMigrationKey(
  bucket,
  objectPath
) {
  return sha256(
    `supabase_storage:${bucket}:${objectPath}`
  )
}

async function migrateStorageObject({
  client,
  object,
  existingRecords,
}) {
  const migrationKey =
    storageMigrationKey(
      object.bucket,
      object.path
    )

  const oldRecord =
    existingRecords.get(
      migrationKey
    )

  if (
    oldRecord?.r2_key &&
    oldRecord?.r2_url &&
    await verifyExistingR2({
      client,
      key:
        oldRecord.r2_key,
      fileSize:
        oldRecord.file_size,
      checksum:
        oldRecord.checksum_sha256,
    })
  ) {
    return {
      ...oldRecord,
      reused: true,
    }
  }

  const file =
    await readStorageObject(
      object
    )

  const r2Key =
    buildStorageR2Key({
      bucket:
        object.bucket,
      objectPath:
        object.path,
      file,
    })

  const r2Url =
    `${config.publicUrl}/${r2Key}`

  await uploadAndVerify({
    client,
    key:
      r2Key,
    file,
    sourceKind:
      'supabase-storage',
  })

  const now =
    new Date().toISOString()

  const record = {
    migration_key:
      migrationKey,
    source_kind:
      'supabase_storage',
    old_bucket:
      object.bucket,
    old_path:
      object.path,
    old_url:
      canonicalSourceUrl(
        object.bucket,
        object.path
      ),
    source_table:
      null,
    source_row_id:
      null,
    source_column:
      null,
    r2_key:
      r2Key,
    r2_url:
      r2Url,
    file_size:
      file.size,
    checksum_sha256:
      file.sha256,
    migrated_at:
      now,
    verified_at:
      now,
    delete_after:
      addDaysIso(
        now,
        RETENTION_DAYS
      ),
    deleted_at:
      null,
    status:
      'verified',
  }

  await upsertMigrationRecord(
    record
  )

  existingRecords.set(
    migrationKey,
    record
  )

  return {
    ...record,
    reused: false,
  }
}

async function migrateAllStorageObjects({
  client,
  storageInventory,
  existingRecords,
}) {
  const mapping =
    new Map()

  const results = []

  for (
    const bucketInfo of
    storageInventory
  ) {
    for (
      const object of
      bucketInfo.objects
    ) {
      const label =
        `${object.bucket}/${object.path}`

      try {
        const record =
          await migrateStorageObject({
            client,
            object,
            existingRecords,
          })

        mapping.set(
          storageMapKey(
            object.bucket,
            object.path
          ),
          record
        )

        results.push({
          source:
            label,
          status:
            record.reused
              ? 'REUSED'
              : 'MIGRATED',
          r2_url:
            record.r2_url,
        })

        console.log(
          `${label} -> ${record.reused ? 'reused' : 'verified'}`
        )
      } catch (error) {
        results.push({
          source:
            label,
          status:
            'FAILED',
          error:
            error.message,
        })

        console.error(
          `${label} failed: ${error.message}`
        )
      }
    }
  }

  return {
    mapping,
    results,
  }
}

function decodeInlineMedia(
  value,
  allowBareBase64 = false
) {
  const input =
    clean(value)

  if (!input) return null

  let contentType = ''
  let encoded = ''
  let originalName =
    'inline-media'

  const dataMatch =
    input.match(
      /^data:([^;,]+);base64,([\s\S]+)$/i
    )

  if (dataMatch) {
    contentType =
      clean(
        dataMatch[1]
      )

    encoded =
      dataMatch[2]
  } else if (
    input
      .toLowerCase()
      .startsWith(
        'base64,'
      )
  ) {
    encoded =
      input.slice(7)
  } else if (
    allowBareBase64 &&
    input.length >= 128 &&
    /^[a-z0-9+/=\s]+$/i.test(
      input
    )
  ) {
    encoded = input
  } else {
    return null
  }

  const normalized =
    encoded.replace(
      /\s+/g,
      ''
    )

  let buffer

  try {
    buffer =
      Buffer.from(
        normalized,
        'base64'
      )
  } catch {
    return null
  }

  if (!buffer.length) {
    return null
  }

  contentType =
    contentTypeFromBuffer(
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
    extensionFrom({
      name:
        originalName,
      contentType,
    })

  originalName =
    `${originalName}.${extension}`

  return {
    buffer,
    contentType,
    size:
      buffer.length,
    sha256:
      sha256(buffer),
    originalName,
  }
}

function mediaFieldName(value) {
  const key =
    clean(value)
      .replace(
        /[A-Z]/g,
        (match) =>
          `_${match.toLowerCase()}`
      )

  return /(^|_)(image|img|avatar|cover|thumbnail|proof|qr|audio|video|pdf|attachment|file|media)($|_)/i.test(
    key
  )
}

async function migrateInlineMedia({
  client,
  file,
  table,
  rowId,
  column,
  pathLabel,
  existingRecords,
}) {
  const migrationKey =
    sha256(
      [
        'inline_media',
        table,
        rowId,
        column,
        pathLabel,
        file.sha256,
      ].join(':')
    )

  const oldRecord =
    existingRecords.get(
      migrationKey
    )

  if (
    oldRecord?.r2_key &&
    oldRecord?.r2_url &&
    await verifyExistingR2({
      client,
      key:
        oldRecord.r2_key,
      fileSize:
        oldRecord.file_size,
      checksum:
        oldRecord.checksum_sha256,
    })
  ) {
    return {
      ...oldRecord,
      reused: true,
    }
  }

  const extension =
    extensionFrom({
      name:
        file.originalName,
      contentType:
        file.contentType,
    })

  const r2Key = [
    'inline-migration',
    safePart(table),
    safePart(
      rowId,
      'row'
    ),
    `${safePart(column)}-${sha256(pathLabel).slice(0, 8)}-${file.sha256.slice(0, 16)}.${extension}`,
  ].join('/')

  const r2Url =
    `${config.publicUrl}/${r2Key}`

  await uploadAndVerify({
    client,
    key:
      r2Key,
    file,
    sourceKind:
      'inline-media',
  })

  const now =
    new Date().toISOString()

  const record = {
    migration_key:
      migrationKey,
    source_kind:
      'inline_media',
    old_bucket:
      null,
    old_path:
      `inline:${table}:${rowId}:${column}:${pathLabel}`,
    old_url:
      null,
    source_table:
      table,
    source_row_id:
      clean(rowId) ||
      null,
    source_column:
      column,
    r2_key:
      r2Key,
    r2_url:
      r2Url,
    file_size:
      file.size,
    checksum_sha256:
      file.sha256,
    migrated_at:
      now,
    verified_at:
      now,
    delete_after:
      null,
    deleted_at:
      null,
    status:
      'verified',
  }

  await upsertMigrationRecord(
    record
  )

  existingRecords.set(
    migrationKey,
    record
  )

  return {
    ...record,
    reused: false,
  }
}

async function resolveStorageReference({
  value,
  storageMapping,
}) {
  const parsed =
    parseSupabaseStorageUrl(
      value
    )

  if (!parsed) {
    throw new Error(
      'Unable to parse Supabase Storage URL'
    )
  }

  const record =
    storageMapping.get(
      storageMapKey(
        parsed.bucket,
        parsed.path
      )
    )

  if (!record?.r2_url) {
    throw new Error(
      `Storage object was not migrated: ${parsed.bucket}/${parsed.path}`
    )
  }

  return record.r2_url
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
  existingRecords,
}) {
  if (typeof value === 'string') {
    const input =
      clean(value)

    if (!input) {
      return {
        value,
        changed: false,
      }
    }

    if (
      isSupabaseStorageUrl(
        input
      )
    ) {
      const r2Url =
        await resolveStorageReference({
          value:
            input,
          storageMapping,
        })

      return {
        value:
          r2Url,
        changed:
          r2Url !== input,
      }
    }

    const inlineFile =
      decodeInlineMedia(
        input,
        mediaFieldName(
          fieldName
        )
      )

    if (inlineFile) {
      const record =
        await migrateInlineMedia({
          client,
          file:
            inlineFile,
          table,
          rowId,
          column,
          pathLabel,
          existingRecords,
        })

      return {
        value:
          record.r2_url,
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
          value:
            value[index],
          client,
          table,
          rowId,
          column,
          pathLabel:
            `${pathLabel}[${index}]`,
          fieldName:
            fieldName,
          storageMapping,
          existingRecords,
        })

      output.push(
        result.value
      )

      changed =
        changed ||
        result.changed
    }

    return {
      value:
        changed
          ? output
          : value,
      changed,
    }
  }

  if (
    value &&
    typeof value === 'object'
  ) {
    const output = {
      ...value,
    }

    let changed = false

    for (
      const [
        key,
        item,
      ] of Object.entries(
        value
      )
    ) {
      const result =
        await transformValue({
          value:
            item,
          client,
          table,
          rowId,
          column,
          pathLabel:
            `${pathLabel}.${key}`,
          fieldName:
            key,
          storageMapping,
          existingRecords,
        })

      if (result.changed) {
        output[key] =
          result.value
        changed = true
      }
    }

    return {
      value:
        changed
          ? output
          : value,
      changed,
    }
  }

  return {
    value,
    changed: false,
  }
}

async function migrateDatabaseReferences({
  client,
  storageMapping,
  existingRecords,
}) {
  const results = []

  for (const target of ACTIVE_TARGETS) {
    const rows =
      await readAllRows(
        target.table,
        {
          optional: true,
        }
      )

    if (rows === null) {
      results.push({
        table:
          target.table,
        status:
          'TABLE_NOT_PRESENT',
      })
      continue
    }

    let updatedRows = 0
    let failedRows = 0

    for (const row of rows) {
      const rowId =
        row.id ??
        row.source_key ??
        row.order_id ??
        row.user_id

      const patch = {}

      try {
        for (
          const column of
          target.columns
        ) {
          if (
            !Object.prototype
              .hasOwnProperty
              .call(
                row,
                column
              )
          ) {
            continue
          }

          const result =
            await transformValue({
              value:
                row[column],
              client,
              table:
                target.table,
              rowId,
              column,
              pathLabel:
                `${target.table}.${column}`,
              fieldName:
                column,
              storageMapping,
              existingRecords,
            })

          if (result.changed) {
            patch[column] =
              result.value
          }
        }

        if (
          !Object.keys(
            patch
          ).length
        ) {
          continue
        }

        if (
          Object.prototype
            .hasOwnProperty
            .call(
              row,
              'updated_at'
            )
        ) {
          patch.updated_at =
            new Date()
              .toISOString()
        }

        if (
          row.id ===
            undefined ||
          row.id === null
        ) {
          throw new Error(
            'Row has media to migrate but no id column'
          )
        }

        const {
          error,
        } = await supabase
          .from(
            target.table
          )
          .update(patch)
          .eq(
            'id',
            row.id
          )

        if (error) {
          throw error
        }

        updatedRows += 1
      } catch (error) {
        failedRows += 1

        console.error(
          `${target.table} row ${rowId} failed: ${error.message}`
        )
      }
    }

    results.push({
      table:
        target.table,
      status:
        failedRows
          ? 'PARTIAL'
          : 'OK',
      updated_rows:
        updatedRows,
      failed_rows:
        failedRows,
    })
  }

  return results
}

async function remainingActiveReferences() {
  return inventoryDatabase()
}

async function writeReport(
  report
) {
  await fs.mkdir(
    OUTPUT_DIR,
    {
      recursive: true,
    }
  )

  const reportPath =
    path.join(
      OUTPUT_DIR,
      isApplyMode()
        ? 'supabase-media-to-r2-apply.json'
        : 'supabase-media-to-r2-dry-run.json'
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
  requireApplyConfig()

  const storageInventory =
    await inventoryStorage()

  const storageObjects =
    storageInventory
      .reduce(
        (
          total,
          bucket
        ) =>
          total +
          bucket.objects.length,
        0
      )

  const databaseInventory =
    await inventoryDatabase()

  if (!isApplyMode()) {
    const report = {
      generated_at:
        new Date()
          .toISOString(),
      mode:
        'DRY_RUN',
      storage_objects:
        storageObjects,
      buckets:
        storageInventory.map(
          (bucket) => ({
            bucket:
              bucket.bucket,
            public:
              bucket.public,
            objects:
              bucket.objects.length,
          })
        ),
      active_database_candidates:
        databaseInventory,
      source_deletion:
        'NOT_PERFORMED',
      retention_days:
        RETENTION_DAYS,
      note:
        'Dry run only. No R2 upload, database update, or Supabase deletion was performed.',
    }

    const reportPath =
      await writeReport(
        report
      )

    console.log(
      JSON.stringify(
        {
          mode:
            report.mode,
          storage_objects:
            report.storage_objects,
          active_database_candidates:
            report
              .active_database_candidates
              .total,
          source_deletion:
            report.source_deletion,
          report:
            reportPath,
        },
        null,
        2
      )
    )

    return
  }

  await ensureMigrationTable()

  const client =
    makeR2Client()

  const existingRecords =
    await loadMigrationRecords()

  const storageResult =
    await migrateAllStorageObjects({
      client,
      storageInventory,
      existingRecords,
    })

  const storageFailed =
    storageResult.results
      .filter(
        (item) =>
          item.status ===
          'FAILED'
      ).length

  if (storageFailed) {
    const report = {
      generated_at:
        new Date()
          .toISOString(),
      mode:
        'APPLY_STOPPED_BEFORE_DB_UPDATE',
      storage_objects:
        storageObjects,
      storage_failed:
        storageFailed,
      storage_results:
        storageResult.results,
      source_deletion:
        'NOT_PERFORMED',
      retention_days:
        RETENTION_DAYS,
      success:
        false,
    }

    const reportPath =
      await writeReport(
        report
      )

    console.error(
      `Storage copy has ${storageFailed} failure(s). Database references were not changed. Report: ${reportPath}`
    )

    process.exitCode = 1
    return
  }

  const databaseResults =
    await migrateDatabaseReferences({
      client,
      storageMapping:
        storageResult.mapping,
      existingRecords,
    })

  const remaining =
    await remainingActiveReferences()

  const databaseFailures =
    databaseResults.reduce(
      (
        total,
        item
      ) =>
        total +
        Number(
          item.failed_rows ||
            0
        ),
      0
    )

  const success =
    storageFailed === 0 &&
    databaseFailures === 0 &&
    remaining.total === 0

  const report = {
    generated_at:
      new Date()
        .toISOString(),
    mode:
      'APPLY_WITHOUT_SOURCE_DELETE',
    storage_objects:
      storageObjects,
    storage_migrated:
      storageResult.results
        .filter(
          (item) =>
            item.status ===
            'MIGRATED'
        ).length,
    storage_reused:
      storageResult.results
        .filter(
          (item) =>
            item.status ===
            'REUSED'
        ).length,
    storage_failed:
      storageFailed,
    database_results:
      databaseResults,
    remaining_active_candidates:
      remaining,
    success,
    source_deletion:
      'NOT_PERFORMED',
    retention_days:
      RETENTION_DAYS,
    delete_after:
      'Each verified Supabase Storage object is retained for 30 days. Deletion is handled separately by the cleanup service.',
  }

  const reportPath =
    await writeReport(
      report
    )

  console.log(
    JSON.stringify(
      {
        mode:
          report.mode,
        storage_objects:
          report.storage_objects,
        storage_migrated:
          report.storage_migrated,
        storage_reused:
          report.storage_reused,
        storage_failed:
          report.storage_failed,
        remaining_active_candidates:
          report
            .remaining_active_candidates
            .total,
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

  if (!success) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(
    'SUPABASE MEDIA MIGRATION FAILED'
  )
  console.error(error)
  process.exit(1)
})
