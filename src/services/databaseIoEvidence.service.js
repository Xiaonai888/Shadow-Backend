const FIELDS = ['calls', 'rows', 'exec_ms', 'read_blocks', 'hit_blocks', 'dirty_blocks', 'written_blocks', 'temp_read_blocks', 'temp_written_blocks', 'wal_bytes']
const DB_FIELDS = ['blks_read', 'blks_hit', 'temp_bytes', 'deadlocks', 'xact_commit', 'xact_rollback']
const FEATURE_RULES = [
  ['system_control', /shadow_database_io_snapshot_v1|system_usage_snapshots|system_usage_incidents/],
  ['spam_guard', /evaluate_spam_guard/],
  ['reader_presence', /reader_presence/],
  ['reader_device_session', /reader_devices|reader_sessions/],
  ['reading_reward', /reader_reading_reward_events|record_reader_reading_reward_session|reader_reading_rewards/],
  ['reading_progress', /reading_progress/],
  ['episode_unlock', /episode_unlocks|episode_unlock_transactions/],
  ['work_guard', /work_kill_switches/],
  ['payment_recovery', /claim_binance_usdt_alerts|telegram_payments/],
  ['chat_cleanup', /expire_due_chat_messages/],
  ['story_catalog', /author_page_stories|reader_stories|discover|stories|episodes/],
  ['notifications', /notifications/],
  ['database_maintenance', /cron\.job_run_details/],
]

function num(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid database IO counter')
  return n
}

function difference(a, b, fractional = false) {
  if (fractional) return num(a) - num(b)
  if (!/^\d+$/.test(String(a)) || !/^\d+$/.test(String(b))) throw new Error('Invalid integer counter')
  return Number(BigInt(a) - BigInt(b))
}

function classify(targets) {
  const matches = FEATURE_RULES.filter(([, re]) => targets.some(target => re.test(target))).map(([name]) => name)
  return matches.length === 1 ? matches[0] : matches.length > 1 ? 'multiple_candidates' : 'unclassified'
}

function metrics(row, prior, blockBytes) {
  const d = Object.fromEntries(FIELDS.map((k, i) => [k, difference(row[i + 2], prior[i + 2], k === 'exec_ms')]))
  if (Object.values(d).some(n => n < 0)) return null
  return {
    calls: d.calls, rows: d.rows, exec_ms: d.exec_ms,
    read_bytes: d.read_blocks * blockBytes, hit_bytes: d.hit_blocks * blockBytes,
    dirty_bytes: d.dirty_blocks * blockBytes, written_bytes: d.written_blocks * blockBytes,
    temp_read_bytes: d.temp_read_blocks * blockBytes, temp_written_bytes: d.temp_written_blocks * blockBytes,
    wal_bytes: d.wal_bytes,
  }
}

const METRICS = ['calls','rows','exec_ms','read_bytes','hit_bytes','dirty_bytes','written_bytes','temp_read_bytes','temp_written_bytes','wal_bytes']
function blank() { return Object.fromEntries(METRICS.map(key => [key, 0])) }
function add(out, row) { for (const key of METRICS) out[key] += row[key] }

export function buildDatabaseIoInterval(previous, current) {
  const duration = (Date.parse(current.captured_at) - Date.parse(previous.captured_at)) / 1000
  const base = { from: previous.captured_at, to: current.captured_at, duration_seconds: duration }
  if (!(duration > 0) || current.server_started_at !== previous.server_started_at || current.stats_reset !== previous.stats_reset || current.block_bytes !== previous.block_bytes) {
    return { ...base, status: 'baseline_changed', reasons: ['restart_or_stats_reset_or_invalid_interval'] }
  }
  const prior = new Map(previous.queries.map(row => [row[0], row]))
  const totals = blank(), features = new Map(), rows = [], reasons = []
  let unmatched = 0, reset = 0
  for (const row of current.queries) {
    const before = prior.get(row[0])
    if (!before) { unmatched++; continue }
    prior.delete(row[0])
    const delta = metrics(row, before, current.block_bytes)
    if (!delta) { reset++; continue }
    if (!METRICS.some(k => delta[k] > 0)) continue
    const targets = row[1], feature = classify(targets)
    const item = { query_key: row[0], targets, feature, ...delta, calls_per_minute: delta.calls * 60 / duration,
      read_bytes_per_call: delta.calls ? delta.read_bytes / delta.calls : null,
      mean_exec_ms: delta.calls ? delta.exec_ms / delta.calls : null }
    rows.push(item)
    add(totals, item)
    if (!features.has(feature)) features.set(feature, blank())
    add(features.get(feature), item)
  }
  if (unmatched || prior.size || reset) reasons.push('new_missing_or_reset_query_counters_excluded')
  if (current.dealloc !== previous.dealloc) reasons.push('statement_evictions_occurred')
  if (current.tracked_count > current.queries.length || previous.tracked_count > previous.queries.length) reasons.push('query_snapshot_truncated')
  if (duration > 1800) reasons.push('long_sampling_gap')
  let database = null
  if (current.database && previous.database && current.database.stats_reset === previous.database.stats_reset) {
    const d = Object.fromEntries(DB_FIELDS.map(k => [k, difference(current.database[k], previous.database[k])]))
    if (Object.values(d).every(n => n >= 0)) database = { ...d, read_bytes: d.blks_read * current.block_bytes, hit_bytes: d.blks_hit * current.block_bytes }
  }
  if (!database) reasons.push('database_counters_unavailable_or_reset')
  const selected = new Map()
  for (const key of ['calls','read_bytes','dirty_bytes','written_bytes','wal_bytes','temp_read_bytes','temp_written_bytes','exec_ms','read_bytes_per_call']) {
    for (const row of [...rows].filter(r => r[key] > 0).sort((a,b) => b[key]-a[key]).slice(0, 15)) selected.set(row.query_key, row)
  }
  return { ...base, status: reasons.length ? 'partial' : 'observed', reasons, totals, database,
    coverage: { matched_active: rows.length, new_excluded: unmatched, missing_excluded: prior.size, reset_excluded: reset, retained_top_queries: selected.size },
    features: [...features].map(([feature, value]) => ({ feature, ...value })), top_queries: [...selected.values()], activity_at_end: current.activity }
}

export function buildDatabaseIoReport(intervals, state) {
  return { version: 1, generated_at: new Date().toISOString(), mode: 'monitoring_only', state,
    interpretation: {
      read_bytes: 'PostgreSQL buffer reads, not guaranteed physical disk reads; OS cache may satisfy them.',
      dirty_bytes: 'Buffers modified, not physical writes.',
      written_bytes: 'Writes attributed to statement execution; excludes other writers.',
      wal_bytes: 'WAL generated, not actual disk bytes; do not add to buffer counters as a disk total.',
      feature: 'Candidate feature derived from known SQL identifiers; not proven HTTP route ownership.',
      calls_per_minute: 'Frequency evidence only; does not prove a loop or error.',
      activity_at_end: 'Point-in-time connections and wait types, not a history of waits.',
      balance: 'Actual Supabase Disk IO Balance percentage is unavailable here.',
      coverage: 'Top-level statements only; partial intervals exclude uncertain deltas. Database counters include other activity and are not directly additive with query counters.',
      error_correlation: 'HTTP and worker error correlation is not wired yet.',
    }, intervals }
}
