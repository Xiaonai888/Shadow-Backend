const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0
const metrics = ['calls','read_bytes','written_bytes','dirty_bytes','wal_bytes','temp_read_bytes','temp_written_bytes','exec_ms']
export function buildDatabaseIoAttribution(interval, traffic) {
  const top = Array.isArray(interval?.top_queries) ? interval.top_queries : []
  const rows = Array.isArray(traffic?.rows) ? traffic.rows : []
  const db = rows.filter(r => r.kind === 'supabase')
  const rankings = Object.fromEntries(metrics.map(key => [key, top.filter(r => valid(r[key]) && r[key] > 0).sort((a,b)=>b[key]-a[key]).slice(0,10).map(r=>({query_key:r.query_key, feature:r.feature, value:r[key]}))]))
  const correlations = top.slice(0,135).map(q => {
    const targets = Array.isArray(q.targets) ? q.targets : []
    const candidates = db.filter(r => r.identifier && targets.includes(r.identifier)).sort((a,b)=>b.calls-a.calls)
    return { query_key:q.query_key, feature:q.feature, targets, association:candidates.length ? 'same_identifier_same_window_candidate' : 'unattributed', candidates:candidates.slice(0,5).map(r=>({route:r.route,target:r.target,calls:r.calls,errors:r.errors,gateway_timeouts:r.gateway_timeouts})), candidate_count:candidates.length }
  })
  const frequent = rows.filter(r=>r.calls > 0).sort((a,b)=>b.calls-a.calls).slice(0,20)
  const failures = rows.filter(r=>r.errors > 0).sort((a,b)=>b.errors-a.errors).slice(0,20)
  return { mode:'monitoring_only', query_rankings:rankings, query_route_candidates:correlations, observed_frequent_calls:frequent, observed_failed_calls:failures, background_targets:db.filter(r=>r.route==='BACKGROUND').sort((a,b)=>b.calls-a.calls).slice(0,20), limitations:['Query and HTTP target correlation is not measured per-route disk IO.','High frequency and repeated failures do not prove a loop or retry.','Physical Disk IO Balance percentage is not measured by this collector.','Rankings use retained query and traffic groups only.','WAL, buffer writes and buffer reads must not be added as physical disk consumption.','Background target identifies the database endpoint, not a specific worker.'] }
}
