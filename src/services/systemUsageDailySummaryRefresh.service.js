import { supabase } from '../config/supabase.js'
import { systemUsageCambodiaDay, buildSystemUsageDailySummary } from './systemUsageDailySummaryBuilder.service.js'
import { listSystemUsageArchiveIndex } from './systemUsageArchiveIndex.service.js'
import { readSystemUsageArchiveObject } from './systemUsageArchiveStorage.service.js'
import { saveSystemUsageDailySummary } from './systemUsageDailySummaryStore.service.js'

export async function refreshSystemUsageDailySummary({
  day, sourceKind = 'observed_aggregates', client = supabase,
} = {}, dependencies = {}) {
  const period = systemUsageCambodiaDay(day)
  const list = dependencies.listArchives || listSystemUsageArchiveIndex
  const read = dependencies.readArchive || readSystemUsageArchiveObject
  const save = dependencies.saveSummary || saveSystemUsageDailySummary
  const selected = []
  let offset = 0

  while (true) {
    const page = await list({ from: period.from, to: period.to, offset, limit: 100, client })
    if (!Array.isArray(page?.rows) || !Number.isSafeInteger(page.total_archives)) {
      throw new Error('Archive index returned incomplete or invalid pagination metadata.')
    }
    for (const entry of page.rows) {
      if (entry.source_kind === sourceKind) selected.push(entry)
    }
    if (page.next_offset === null || page.next_offset === undefined) break
    if (!Number.isSafeInteger(page.next_offset) || page.next_offset <= offset ||
        page.next_offset > 10_000 || selected.length > 512) {
      throw new Error('Archive index pagination limit exceeded.')
    }
    offset = page.next_offset
  }

  if (selected.length === 0) {
    return { status: 'missing', day, source_kind: sourceKind, archived_windows: 0 }
  }
  if (selected.length > 512) throw new RangeError('Daily usage archive limit exceeded.')

  const archives = []
  for (const entry of selected) {
    const downloaded = await read({ path: entry.object_path, manifest: entry.manifest, client })
    if (!downloaded?.recovered?.summary || downloaded?.recovered?.from !== entry.window_from ||
        downloaded?.recovered?.to !== entry.window_to) {
      throw new Error('Archive content does not match its declared time window.')
    }
    archives.push({
      entry,
      recovered: { ...downloaded.recovered, manifest_sha256: entry.manifest.sha256 },
    })
  }
  const summary = buildSystemUsageDailySummary({ day, sourceKind, archives })
  const stored = await save(summary, { client })
  return {
    status: 'saved',
    day,
    source_kind: sourceKind,
    archived_windows: selected.length,
    summary_sha256: stored.summary_sha256,
    coverage: summary.coverage,
  }
}
