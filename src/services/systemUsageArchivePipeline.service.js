import { createHash } from 'node:crypto'
import {
  createSystemUsageGroupArchive,
  paginateSystemUsageGroups,
} from './systemUsageGroupedArchive.service.js'
import {
  readSystemUsageArchiveObject,
  writeSystemUsageArchiveObject,
  SYSTEM_USAGE_ARCHIVE_BUCKET,
} from './systemUsageArchiveStorage.service.js'
import {
  getSystemUsageArchiveIndex,
  listSystemUsageArchiveIndex,
  saveSystemUsageArchiveIndex,
} from './systemUsageArchiveIndex.service.js'

function totalsMatch(a, b) {
  const fields = Object.keys(a || {})
  return fields.length === Object.keys(b || {}).length &&
    fields.every((field) => a[field] === b[field])
}

function normalizedRange(from, to) {
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new RangeError('Invalid system usage archive window.')
  }
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() }
}

function archiveIdentity({ from, to, sha256, sourceKind }) {
  return createHash('sha256').update(JSON.stringify([from, to, sha256, sourceKind])).digest('hex')
}

export async function persistSystemUsageGroupedArchive({
  rows, from, to, sourceKind = 'observed_aggregates', coverage = {}, client,
} = {}) {
  const range = normalizedRange(from, to)
  if (!sourceKind || typeof sourceKind !== 'string' || sourceKind.length > 80 ||
      !/^[a-z0-9_:-]+$/.test(sourceKind)) {
    throw new TypeError('Invalid archive source kind.')
  }
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
    throw new TypeError('System usage archive coverage must be an object.')
  }

  const { summary, manifest, archive } = createSystemUsageGroupArchive(rows, range)
  const archiveKey = archiveIdentity({ ...range, sha256: manifest.sha256, sourceKind })
  const path = `v1/${range.from.slice(0, 10)}/${archiveKey}.json.gz`
  const database = client ? { client } : {}
  await writeSystemUsageArchiveObject({ path, archive, manifest, ...database })

  const entry = await saveSystemUsageArchiveIndex({
    archive_key: archiveKey,
    bucket: SYSTEM_USAGE_ARCHIVE_BUCKET,
    object_path: path,
    window_from: range.from,
    window_to: range.to,
    source_kind: sourceKind,
    source_complete: false,
    source_rows: summary.source_rows,
    group_count: summary.group_count,
    totals: summary.totals,
    coverage: { ...coverage, archival_capture: 'supplied_rows_only', event_level_complete: false },
    manifest,
  }, database)

  return { entry, summary, verified: true }
}

export async function readSystemUsageGroupedArchive({ archiveKey, offset = 0, limit = 50, client } = {}) {
  const database = client ? { client } : {}
  const entry = await getSystemUsageArchiveIndex(archiveKey, database)
  if (!entry) return null
  const { recovered } = await readSystemUsageArchiveObject({
    path: entry.object_path, manifest: entry.manifest, ...database,
  })
  if (entry.bucket !== SYSTEM_USAGE_ARCHIVE_BUCKET ||
      recovered.summary.source_rows !== entry.source_rows ||
      recovered.summary.group_count !== entry.group_count ||
      !totalsMatch(recovered.summary.totals, entry.totals)) {
    throw new Error('System usage archive index totals do not match verified source data.')
  }
  return {
    entry,
    page: paginateSystemUsageGroups(recovered.summary, { offset, limit }),
    verification: { sha256: entry.manifest.sha256, verified: true },
  }
}

export async function findSystemUsageGroupedArchives(options = {}) {
  return listSystemUsageArchiveIndex(options)
}
