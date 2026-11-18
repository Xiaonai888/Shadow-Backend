import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'

const VERSION = 1
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const MAX_PAGE_SIZE = 100
const DIMENSION_FIELDS = [
  'provider', 'service_id', 'kind', 'feature', 'dependency',
  'source_route', 'source_method', 'source_path', 'operation_method',
  'target_path', 'route', 'upload_mode', 'traffic_source',
  'status', 'error_code', 'error_type', 'unit',
]
const COUNTER_FIELDS = [
  'count', 'bytes', 'errors', 'requests', 'attempts', 'successes',
  'failures', 'ingress_bytes', 'egress_bytes', 'object_bytes',
]

function asRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('Usage archive rows must be an array.')
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError('Every usage archive row must be an object.')
    }
  }
  return rows
}

function metric(value, field) {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid usage counter: ${field}`)
  }
  return value
}

function addExact(a, b, field) {
  const value = a + b
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Usage counter exceeded safe integer precision: ${field}`)
  }
  return value
}

function dimensions(row) {
  return Object.fromEntries(DIMENSION_FIELDS
    .filter((field) => row[field] !== undefined && row[field] !== null)
    .map((field) => [field, String(row[field])]))
}

function digest(data) {
  return createHash('sha256').update(data).digest('hex')
}

function summarizeCounters(rows) {
  const counters = Object.fromEntries(COUNTER_FIELDS.map((field) => [field, null]))
  for (const row of rows) {
    for (const field of COUNTER_FIELDS) {
      const n = metric(row[field], field)
      if (n !== null) counters[field] = addExact(counters[field] ?? 0, n, field)
    }
  }
  return counters
}

export function groupSystemUsageRows(sourceRows = []) {
  const rows = asRows(sourceRows)
  const groups = new Map()

  for (const row of rows) {
    const identity = dimensions(row)
    const fingerprint = JSON.stringify(identity)
    let group = groups.get(fingerprint)
    if (!group) {
      group = {
        fingerprint,
        dimensions: identity,
        source_rows: 0,
        counters: Object.fromEntries(COUNTER_FIELDS.map((field) => [field, null])),
      }
      groups.set(fingerprint, group)
    }
    group.source_rows = addExact(group.source_rows, 1, 'source_rows')
    for (const field of COUNTER_FIELDS) {
      const n = metric(row[field], field)
      if (n !== null) {
        group.counters[field] = addExact(group.counters[field] ?? 0, n, field)
      }
    }
  }

  const result = [...groups.values()].sort((a, b) =>
    (b.counters.bytes ?? 0) - (a.counters.bytes ?? 0) ||
    (b.counters.errors ?? 0) - (a.counters.errors ?? 0) ||
    a.fingerprint.localeCompare(b.fingerprint)
  )
  const totals = summarizeCounters(rows)
  const calculated = summarizeCounters(result.map((group) => group.counters))
  for (const field of COUNTER_FIELDS) {
    if (totals[field] !== calculated[field]) {
      throw new Error(`Grouped usage verification failed: ${field}`)
    }
  }

  return {
    source_rows: rows.length,
    group_count: result.length,
    totals,
    groups: result,
    complete_group_list: true,
  }
}

export function createSystemUsageGroupArchive(sourceRows, options = {}) {
  const rows = asRows(sourceRows)
  const summary = groupSystemUsageRows(rows)
  const from = options.from == null ? null : String(options.from)
  const to = options.to == null ? null : String(options.to)
  const envelope = { version: VERSION, from, to, rows }
  const serialized = JSON.stringify(envelope)
  if (typeof serialized !== 'string') throw new TypeError('Archive is not serializable.')
  const raw = Buffer.from(serialized, 'utf8')
  if (raw.length > MAX_ARCHIVE_BYTES) {
    throw new RangeError('Archive batch exceeds 16 MiB; split by hour or service.')
  }
  const compressed = gzipSync(raw, { level: 6 })
  return {
    summary,
    manifest: {
      version: VERSION,
      from,
      to,
      source_rows: rows.length,
      group_count: summary.group_count,
      uncompressed_bytes: raw.length,
      compressed_bytes: compressed.length,
      sha256: digest(raw),
      format: 'json+gzip',
    },
    archive: compressed,
  }
}

export function verifySystemUsageGroupArchive(compressed, manifest) {
  if (!Buffer.isBuffer(compressed)) throw new TypeError('Archive must be a Buffer.')
  if (manifest?.version !== VERSION || manifest?.format !== 'json+gzip') {
    throw new Error('Unsupported usage archive manifest.')
  }
  if (compressed.length !== manifest.compressed_bytes) {
    throw new Error('Usage archive compressed length mismatch.')
  }
  const raw = gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_BYTES + 1 })
  if (raw.length !== manifest.uncompressed_bytes || digest(raw) !== manifest.sha256) {
    throw new Error('Usage archive checksum mismatch.')
  }
  const parsed = JSON.parse(raw.toString('utf8'))
  if (parsed?.version !== VERSION || !Array.isArray(parsed.rows) ||
      parsed.rows.length !== manifest.source_rows ||
      parsed.from !== manifest.from || parsed.to !== manifest.to) {
    throw new Error('Usage archive metadata mismatch.')
  }
  const summary = groupSystemUsageRows(parsed.rows)
  if (summary.group_count !== manifest.group_count) {
    throw new Error('Usage archive group count mismatch.')
  }
  return { ...parsed, summary }
}

export function paginateSystemUsageGroups(summary, { offset = 0, limit = 50 } = {}) {
  if (!Array.isArray(summary?.groups) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RangeError('Invalid grouped usage page request.')
  }
  return {
    rows: summary.groups.slice(offset, offset + limit),
    total_groups: summary.groups.length,
    next_offset: offset + limit < summary.groups.length ? offset + limit : null,
    totals: summary.totals,
  }
}
