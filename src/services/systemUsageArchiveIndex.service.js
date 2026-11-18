import { supabase } from '../config/supabase.js'

const TABLE = 'system_usage_archives'
const COLUMNS = 'archive_key,bucket,object_path,window_from,window_to,source_kind,source_complete,source_rows,group_count,totals,coverage,manifest,created_at'

function equivalentJson(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((value, index) => equivalentJson(value, b[index]))
  }
  if (typeof a !== 'object') return false
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  return aKeys.length === bKeys.length && aKeys.every((key, index) =>
    key === bKeys[index] && equivalentJson(a[key], b[key]))
}

function validKey(key) {
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) {
    throw new TypeError('Invalid system usage archive key.')
  }
  return key
}

function dates(from, to) {
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new RangeError('Invalid system usage archive date range.')
  }
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() }
}

export async function getSystemUsageArchiveIndex(key, { client = supabase } = {}) {
  validKey(key)
  const { data, error } = await client.from(TABLE).select(COLUMNS).eq('archive_key', key).maybeSingle()
  if (error) throw new Error('System usage archive index lookup failed.', { cause: error })
  return data || null
}

export async function saveSystemUsageArchiveIndex(entry, { client = supabase } = {}) {
  validKey(entry?.archive_key)
  const range = dates(entry.window_from, entry.window_to)
  if (entry.manifest?.sha256 == null || entry.source_rows !== entry.manifest.source_rows ||
      entry.group_count !== entry.manifest.group_count) {
    throw new TypeError('System usage archive index does not match its manifest.')
  }
  const payload = {
    archive_key: entry.archive_key,
    bucket: entry.bucket,
    object_path: entry.object_path,
    window_from: range.from,
    window_to: range.to,
    source_kind: entry.source_kind,
    source_complete: entry.source_complete === true,
    source_rows: entry.source_rows,
    group_count: entry.group_count,
    totals: entry.totals,
    coverage: entry.coverage,
    manifest: entry.manifest,
  }
  const { data, error } = await client.from(TABLE).insert(payload).select(COLUMNS).single()
  if (!error) return data
  if (String(error.code) !== '23505') {
    throw new Error('System usage archive index insert failed.', { cause: error })
  }
  const existing = await getSystemUsageArchiveIndex(entry.archive_key, { client })
  if (!existing || existing.bucket !== payload.bucket || existing.object_path !== payload.object_path ||
      existing.manifest?.sha256 !== payload.manifest.sha256 ||
      Date.parse(existing.window_from) !== Date.parse(payload.window_from) ||
      Date.parse(existing.window_to) !== Date.parse(payload.window_to) ||
      existing.source_rows !== payload.source_rows || existing.group_count !== payload.group_count ||
      existing.source_kind !== payload.source_kind || existing.source_complete !== payload.source_complete ||
      !equivalentJson(existing.totals, payload.totals) ||
      !equivalentJson(existing.coverage, payload.coverage)) {
    throw new Error('Conflicting system usage archive index entry.')
  }
  return existing
}

export async function listSystemUsageArchiveIndex({ from, to, offset = 0, limit = 50, client = supabase } = {}) {
  const range = dates(from, to)
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Invalid system usage archive pagination.')
  }
  const { data, error, count } = await client.from(TABLE)
    .select(COLUMNS, { count: 'exact' })
    .lt('window_from', range.to)
    .gt('window_to', range.from)
    .order('window_from', { ascending: true })
    .order('archive_key', { ascending: true })
    .range(offset, offset + limit - 1)
  if (error) throw new Error('System usage archive index listing failed.', { cause: error })
  return {
    rows: data || [],
    total_archives: count,
    next_offset: count !== null && offset + (data || []).length < count ? offset + (data || []).length : null,
  }
}
