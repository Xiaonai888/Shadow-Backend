import { getDatabaseIoTrafficEvidence } from './databaseIoTrafficEvidence.service.js'
import { buildDatabaseIoAttribution } from './databaseIoAttribution.service.js'
export function attachDatabaseIoEvidence(interval) {
  if (!interval || typeof interval !== 'object') return interval
  const traffic = getDatabaseIoTrafficEvidence(interval.from, interval.to)
  return { ...interval, traffic_evidence:traffic, attribution:buildDatabaseIoAttribution(interval,traffic) }
}
export function buildDatabaseIoEvidenceExport(report) {
  const intervals = Array.isArray(report?.intervals) ? report.intervals : []
  return { version:1, generated_at:new Date().toISOString(), mode:'monitoring_only', state:report?.state || null, interpretation:report?.interpretation || null, coverage:{ intervals:intervals.length, correlated:intervals.filter(r=>r.traffic_evidence && r.traffic_evidence.status !== 'not_connected').length, partial:intervals.filter(r=>r.status !== 'observed' || r.traffic_evidence?.status !== 'observed').length }, intervals:intervals.map(r=>r.attribution ? r : {...r, traffic_evidence:{status:'not_captured'}, attribution:buildDatabaseIoAttribution(r,null)}), note:'Historical evidence is recorded at sampling time; missing traffic must not be reconstructed from current counters.' }
}
