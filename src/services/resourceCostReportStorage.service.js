import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'

const TABLE = 'resource_cost_report_files'
const BUCKET = 'shadow-resource-cost-reports'
const PART_BYTES = 2_000_000
const MAX_BYTES = 60_000_000
const RETENTION_MS = 24 * 60 * 60 * 1000
const REUSE_MS = 15 * 60 * 1000
const WRITE_TTL_MS = 2 * 60 * 60 * 1000
const MAX_FILES = 10
const COLUMNS = 'id,owner_id,report_key,format,filename,content_type,size_bytes,part_count,part_hashes,status,created_at,ready_at,expires_at'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
let nextCleanupAt = 0
let cleanupRunning = false

async function db(client) {
  return client || (await import('../config/supabase.js')).supabase
}

function ensure(result, stage) {
  if (result?.error) throw Object.assign(new Error(`Report storage ${stage} failed.`), { code: 'RESOURCE_COST_STORAGE_ERROR', cause: result.error })
  return result?.data
}

function partPath(id, index) {
  if (!UUID.test(id) || !Number.isInteger(index) || index < 0 || index >= MAX_BYTES / PART_BYTES) throw new TypeError('Invalid report part.')
  return `${id}/${String(index).padStart(3, '0')}.part`
}

function partPaths(row) {
  const count = Number(row.part_count)
  if (!Number.isInteger(count) || count < 1 || count > MAX_BYTES / PART_BYTES) throw new TypeError('Invalid report part count.')
  return Array.from({ length: count }, (_, i) => partPath(row.id, i))
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function notFound() {
  return Object.assign(new Error('Report job not found or expired.'), { code: 'RESOURCE_COST_JOB_NOT_FOUND' })
}

export function storedReportJob(row) {
  return {
    id: row.id, status: 'ready', stage: 'ready', progress: 100,
    format: row.format, created_at: row.created_at, updated_at: row.ready_at,
    expires_at: row.expires_at, filename: row.filename, size_bytes: row.size_bytes,
    error_code: null, reason: null, download_ready: true,
  }
}

async function removeParts(database, row) {
  ensure(await database.storage.from(BUCKET).remove(partPaths(row)), 'delete parts')
  ensure(await database.from(TABLE).delete().eq('id', row.id).eq('status', 'deleting'), 'delete metadata')
}

async function retire(database, row) {
  const claimed = ensure(await database.from(TABLE).update({ status: 'deleting', expires_at: new Date().toISOString() })
    .eq('id', row.id).eq('status', row.status).select(COLUMNS).maybeSingle(), 'claim deletion')
  if (claimed) await removeParts(database, claimed)
}

export async function cleanupExpiredResourceCostReports(client = null) {
  if (cleanupRunning || Date.now() < nextCleanupAt) return
  cleanupRunning = true
  nextCleanupAt = Date.now() + 5 * 60 * 1000
  try {
    const database = await db(client)
    const rows = ensure(await database.from(TABLE).select(COLUMNS).lte('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: true }).limit(3), 'list expired reports') || []
    for (const row of rows) {
      try { await retire(database, row) } catch (error) {
        console.warn('RESOURCE_COST_STORAGE_CLEANUP_ERROR:', error?.code || 'UNKNOWN')
      }
    }
  } finally {
    cleanupRunning = false
  }
}

export async function findStoredResourceCostReport(owner, key, client = null) {
  const database = await db(client)
  return ensure(await database.from(TABLE).select(COLUMNS).eq('owner_id', owner).eq('report_key', key).eq('status', 'ready')
    .gt('expires_at', new Date().toISOString()).gte('ready_at', new Date(Date.now() - REUSE_MS).toISOString())
    .order('ready_at', { ascending: false }).limit(1).maybeSingle(), 'find report') || null
}

export async function getStoredResourceCostReport(owner, id, client = null) {
  if (!owner || !UUID.test(id)) throw notFound()
  const database = await db(client)
  const row = ensure(await database.from(TABLE).select(COLUMNS).eq('id', id).eq('owner_id', owner).eq('status', 'ready')
    .gt('expires_at', new Date().toISOString()).maybeSingle(), 'read report')
  if (!row) throw notFound()
  return row
}

export async function listStoredResourceCostReports(owner, offset = 0, limit = 10, client = null) {
  if (!owner || !Number.isInteger(offset) || offset < 0 || offset > 100 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new RangeError('Invalid report history pagination.')
  const database = await db(client)
  const rows = ensure(await database.from(TABLE).select(COLUMNS).eq('owner_id', owner).eq('status', 'ready')
    .gt('expires_at', new Date().toISOString()).order('ready_at', { ascending: false }).order('id', { ascending: false })
    .range(offset, offset + limit), 'list reports') || []
  return { jobs: rows.slice(0, limit).map(storedReportJob), next_offset: rows.length > limit ? offset + limit : null }
}

export async function ensureResourceCostStorageCapacity(client = null) {
  const database = await db(client)
  const countResult = await database.from(TABLE).select('id', { count: 'exact', head: true })
  ensure(countResult, 'check storage capacity')
  if (!Number.isInteger(countResult.count) || countResult.count >= MAX_FILES) throw Object.assign(new Error('Report storage is temporarily full.'), { code: 'RESOURCE_COST_BUSY', reason: 'report_storage_full' })
}

export async function saveResourceCostReportFile({ id, owner, key, format, file, checkpoint = () => {}, onProgress = () => {}, client = null }) {
  if (!UUID.test(id) || !owner || !key || !file || !Number.isInteger(file.size) || file.size < 1 || file.size > MAX_BYTES) throw new RangeError('Invalid report file size or identity.')
  const database = await db(client)
  await ensureResourceCostStorageCapacity(database)
  const row = {
    id, owner_id: owner, report_key: key, format, filename: file.filename, content_type: file.contentType,
    size_bytes: file.size, part_count: Math.ceil(file.size / PART_BYTES), status: 'writing',
    expires_at: new Date(Date.now() + WRITE_TTL_MS).toISOString(),
  }
  await checkpoint()
  ensure(await database.from(TABLE).insert(row), 'reserve file')
  let handle
  try {
    handle = await open(file.path, 'r')
    if ((await handle.stat()).size !== file.size) throw new Error('Report file size changed.')
    const hashes = []
    for (let index = 0, offset = 0; index < row.part_count; index++) {
      await checkpoint()
      const size = Math.min(PART_BYTES, file.size - offset)
      const buffer = Buffer.allocUnsafe(size)
      let received = 0
      while (received < size) {
        const { bytesRead } = await handle.read(buffer, received, size - received, offset + received)
        if (!bytesRead) throw new Error('Report file ended unexpectedly.')
        received += bytesRead
      }
      hashes.push(digest(buffer))
      ensure(await database.storage.from(BUCKET).upload(partPath(id, index), buffer, { contentType: 'application/octet-stream', upsert: false }), 'upload part')
      offset += size
      await onProgress({ completed: index + 1, total: row.part_count })
    }
    await checkpoint()
    const now = Date.now()
    const ready = ensure(await database.from(TABLE).update({ status: 'ready', part_hashes: hashes, ready_at: new Date(now).toISOString(), expires_at: new Date(now + RETENTION_MS).toISOString() })
      .eq('id', id).eq('status', 'writing').select(COLUMNS).single(), 'finalize file')
    if (!ready || ready.status !== 'ready') throw new Error('Report storage finalization failed.')
    return ready
  } catch (error) {
    try { await retire(database, row) } catch (cleanupError) { console.warn('RESOURCE_COST_STORAGE_CLEANUP_ERROR:', cleanupError?.code || 'UNKNOWN') }
    throw error
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

export function openStoredResourceCostReport(row, { client = null, canceled = () => false } = {}) {
  async function* read() {
    const database = await db(client)
    const paths = partPaths(row)
    if (!Array.isArray(row.part_hashes) || row.part_hashes.length !== paths.length) throw new Error('Report integrity metadata is missing.')
    for (let index = 0; index < paths.length; index++) {
      if (canceled()) return
      const part = ensure(await database.storage.from(BUCKET).download(paths[index]), 'download part')
      const expected = Math.min(PART_BYTES, row.size_bytes - index * PART_BYTES)
      if (!part || part.size !== expected || typeof part.arrayBuffer !== 'function') throw new Error('Report part size mismatch.')
      const buffer = Buffer.from(await part.arrayBuffer())
      if (buffer.length !== expected || digest(buffer) !== row.part_hashes[index]) throw new Error('Report part checksum mismatch.')
      if (canceled()) return
      yield buffer
    }
  }
  return Readable.from(read(), { objectMode: false, highWaterMark: 64 * 1024 })
}

export async function deleteStoredResourceCostReport(owner, id, client = null) {
  const database = await db(client)
  const row = await getStoredResourceCostReport(owner, id, database)
  await retire(database, row)
  return { deleted: true }
}
