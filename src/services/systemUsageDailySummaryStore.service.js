import { supabase } from '../config/supabase.js'
import { systemUsageCambodiaDay } from './systemUsageDailySummaryBuilder.service.js'

const TABLE = 'system_usage_daily_summaries'
const COLUMNS = 'summary_date,source_kind,archive_set_sha256,summary_sha256,archive_keys,source_rows,group_count,totals,breakdown,coverage,updated_at'
const FAST_COLUMNS = 'summary_date,source_kind,archive_set_sha256,summary_sha256,source_rows,group_count,totals,coverage,updated_at'

function validSourceKind(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_:-]{1,80}$/.test(value)) {
    throw new TypeError('Invalid daily summary source kind.')
  }
  return value
}

function validateSummary(summary) {
  systemUsageCambodiaDay(summary?.summary_date)
  validSourceKind(summary?.source_kind)
  if (!/^[0-9a-f]{64}$/.test(String(summary.archive_set_sha256)) ||
      !/^[0-9a-f]{64}$/.test(String(summary.summary_sha256)) ||
      !Array.isArray(summary.archive_keys) || !summary.archive_keys.length ||
      new Set(summary.archive_keys).size !== summary.archive_keys.length ||
      summary.archive_keys.some((key) => !/^[0-9a-f]{64}$/.test(String(key))) ||
      !Number.isSafeInteger(summary.source_rows) || summary.source_rows < 0 ||
      !Number.isSafeInteger(summary.group_count) || summary.group_count < 0 ||
      !summary.totals || !Array.isArray(summary.breakdown) || !summary.coverage) {
    throw new TypeError('Invalid daily summary verification fields.')
  }
  return summary
}

export async function saveSystemUsageDailySummary(summary, { client = supabase } = {}) {
  const validated = validateSummary(summary)
  const { data, error } = await client.rpc('save_system_usage_daily_summary', {
    p_summary: validated,
  })
  if (error) throw new Error('Failed to save verified daily usage summary.', { cause: error })
  if (!data || data.length !== 1 || data[0].summary_sha256 !== validated.summary_sha256) {
    throw new Error('Daily summary is stale or conflicts with previously saved archive evidence.')
  }
  return data[0]
}

export async function readSystemUsageDailySummary({ day, sourceKind = 'observed_aggregates', client = supabase } = {}) {
  systemUsageCambodiaDay(day)
  validSourceKind(sourceKind)
  const { data, error } = await client.from(TABLE).select(COLUMNS)
    .eq('summary_date', day).eq('source_kind', sourceKind).maybeSingle()
  if (error) throw new Error('Failed to load saved daily summary.', { cause: error })
  return data || null
}

export async function listSystemUsageDailySummaries({
  from, to, sourceKind = 'observed_aggregates', offset = 0, limit = 100, client = supabase,
} = {}) {
  systemUsageCambodiaDay(from)
  systemUsageCambodiaDay(to)
  validSourceKind(sourceKind)
  if (from > to || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Invalid daily summary query range or pagination.')
  }
  const { data, error, count } = await client.from(TABLE)
    .select(FAST_COLUMNS, { count: 'exact' })
    .eq('source_kind', sourceKind)
    .gte('summary_date', from)
    .lte('summary_date', to)
    .order('summary_date', { ascending: true })
    .range(offset, offset + limit - 1)
  if (error) throw new Error('Failed to query daily usage summaries.', { cause: error })
  if (!Number.isSafeInteger(count)) {
    throw new Error('Daily summary pagination requires an exact row count.')
  }
  const rows = data || []
  return {
    rows,
    total_days: count,
    next_offset: count !== null && offset + rows.length < count ? offset + rows.length : null,
  }
}
