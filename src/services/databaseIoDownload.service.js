import { getDatabaseIoReport } from './databaseIoMonitor.service.js'
import { getDatabaseIoArchiveState, getDatabaseIoArchivedInterval } from './databaseIoHistory.service.js'
import { readDatabaseIoObject } from './databaseIoArchiveStorage.service.js'
import { databaseIoDay, compactDatabaseIoInterval, summarizeDatabaseIoDay } from './databaseIoDailySummary.service.js'
import { buildDatabaseIoAttribution } from './databaseIoAttribution.service.js'

const DAY = 86400000
const OFFSET = 7 * 3600000
const LIMIT = 12
const FIELDS = ['calls','rows','exec_ms','read_bytes','hit_bytes','dirty_bytes','written_bytes','temp_read_bytes','temp_written_bytes','wal_bytes']
const RANK = ['read_bytes','written_bytes','wal_bytes','temp_written_bytes','calls','exec_ms']
let busy = false
const blank = () => Object.fromEntries(FIELDS.map(k => [k,null]))
function add(dst,src) {
  for (const k of FIELDS) if (typeof src?.[k] === 'number' && Number.isFinite(src[k]) && src[k] >= 0) dst[k] = (dst[k] ?? 0) + src[k]
}
function datesFor(range) {
  const dates=[]
  for(let t=Math.floor((range.from+OFFSET)/DAY)*DAY;t<=Math.floor((range.to+OFFSET)/DAY)*DAY;t+=DAY) dates.push(new Date(t).toISOString().slice(0,10))
  return dates
}
async function bounded(items,fn,deadline) {
  const result = new Array(items.length)
  let index=0
  await Promise.all(Array.from({length:Math.min(3,items.length)},async()=>{
    while(index<items.length && Date.now()<deadline) {
      const i=index++
      try {result[i]=await fn(items[i])} catch {result[i]=null}
    }
  }))
  return result
}
function selectDetails(rows) {
  const map=new Map()
  for(const key of RANK) for(const r of [...rows].filter(r=>(r.totals?.[key]??0)>0).sort((a,b)=>b.totals[key]-a.totals[key]).slice(0,2)) map.set(r.id,r)
  for(const r of [...rows].reverse()) {if(map.size>=LIMIT) break;map.set(r.id,r)}
  return [...map.values()].slice(0,LIMIT)
}
function rankObservedQueries(details) {
  const queries = new Map()
  let intervalsWithQueries = 0
  for (const interval of details) {
    if (interval.status === 'detail_unavailable') continue
    const seen = new Set()
    for (const query of interval.top_queries || []) {
      const key = typeof query?.query_key === 'string' || typeof query?.query_key === 'number'
        ? String(query.query_key).trim() : ''
      if (!key || seen.has(key)) continue
      seen.add(key)
      const row = queries.get(key) || {
        query_key: key,
        feature: query.feature || 'unknown',
        targets: [],
        observed_intervals: 0,
        ...blank(),
      }
      row.observed_intervals++
      if (row.feature !== (query.feature || 'unknown')) row.feature = 'mixed'
      row.targets = [...new Set([...row.targets, ...(Array.isArray(query.targets) ? query.targets.filter(t => typeof t === 'string') : [])])].slice(0, 12)
      add(row, query)
      queries.set(key, row)
    }
    if (seen.size) intervalsWithQueries++
  }
  const rows = [...queries.values()]
  return {
    scope: 'retained_top_queries_in_selected_intervals_only',
    intervals_with_queries: intervalsWithQueries,
    distinct_observed_queries: rows.length,
    limit_per_metric: 10,
    rankings: Object.fromEntries(RANK.map(k => [k, rows.filter(r => (r[k] ?? 0) > 0).sort((a,b) => b[k] - a[k] || a.query_key.localeCompare(b.query_key)).slice(0,10)])),
  }
}

export async function buildDatabaseIoDownload(range) {
  if(busy) return null
  busy=true
  try {
    const deadline=Date.now()+12000, report=getDatabaseIoReport(), archive=getDatabaseIoArchiveState()
    const dates=datesFor(range), live=new Map(report.intervals.map(r=>[compactDatabaseIoInterval(r).id,r]))
    const stored=archive.configured?await bounded(dates,async day=>({record:await readDatabaseIoObject(`database-io/v1/daily/${day}.json.gz`)}),deadline):[]
    const all=new Map(), days=[], totals=blank(), features=new Map(), archiveCoverage=[]
    let boundary=0,overlaps=0,lastEnd=0,covered=0,partial=0,missing=0
    for(let i=0;i<dates.length;i++) {
      const day=dates[i], entry=stored[i], obj=entry?.record
      const valid=obj?.version===1&&obj.day===day&&Array.isArray(obj.intervals)&&obj.intervals.length<=128
      archiveCoverage.push({day,status:!archive.configured?'not_configured':valid?'available':obj?'invalid':entry?'missing':'unavailable_or_not_checked'})
      if(valid) for(const row of obj.intervals) all.set(row.id,row)
    }
    for(const [id,r] of live) all.set(id,compactDatabaseIoInterval(r))
    const accepted=[]
    for(const r of [...all.values()].sort((a,b)=>Date.parse(a.from)-Date.parse(b.from))) {
      const start=Date.parse(r.from),end=Date.parse(r.to)
      if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start) continue
      if(end<=range.from||start>=range.to) continue
      if(start<range.from||end>range.to) {boundary++;continue}
      if(r.status==='baseline_changed'||!r.totals){missing++;continue}
      if(start<lastEnd){overlaps++;continue}
      lastEnd=end; covered+=(end-start)/1000; if(r.status==='partial')partial++
      accepted.push(r);add(totals,r.totals)
      for(const f of r.features||[]) {if(!features.has(f.feature))features.set(f.feature,blank());add(features.get(f.feature),f)}
    }
    for(const day of dates) days.push(summarizeDatabaseIoDay({version:1,day,timezone:'Asia/Phnom_Penh',allocation:'interval_end_day',intervals:accepted.filter(r=>databaseIoDay(r.to)===day)}))
    const selected=selectDetails(accepted)
    const archivedDetails=archive.configured?await bounded(selected,async row=>live.has(row.id)?live.get(row.id):await getDatabaseIoArchivedInterval(row.from,row.to),deadline):[]
    const details=selected.map((r,i)=>{
      const raw=live.get(r.id)||archivedDetails[i]
      return raw?{id:r.id,from:r.from,to:r.to,status:raw.status,reasons:raw.reasons,totals:raw.totals,database:raw.database,activity_at_end:raw.activity_at_end,coverage:raw.coverage,top_queries:raw.top_queries||[],traffic_evidence:raw.traffic_evidence||{status:'not_captured',rows:[]},attribution:raw.attribution||buildDatabaseIoAttribution(raw,raw.traffic_evidence)}:{id:r.id,from:r.from,to:r.to,status:'detail_unavailable'}
    })
    const featureRows=[...features].map(([feature,v])=>({feature,...v}))
    const rankings=Object.fromEntries(RANK.map(k=>[k,[...featureRows].filter(r=>(r[k]??0)>0).sort((a,b)=>b[k]-a[k]).slice(0,15)]))
    return {version:1,mode:'monitoring_only',generated_at:new Date().toISOString(),range:{from:new Date(range.from).toISOString(),to:new Date(range.to).toISOString()},state:report.state,totals,features:featureRows,rankings,query_rankings:rankObservedQueries(details),days,archive_coverage:archiveCoverage,coverage:{accepted_intervals:accepted.length,partial_intervals:partial,baseline_missing:missing,excluded_boundary_intervals:boundary,excluded_overlaps:overlaps,covered_seconds:covered,uncovered_seconds:Math.max(0,(range.to-range.from)/1000-covered),detail_selected:selected.length,detail_available:details.filter(r=>r.status!=='detail_unavailable').length},details,interpretation:report.interpretation,limitations:['Provider Disk IO Balance is not measured. PostgreSQL buffer reads, writes and WAL are not additive physical disk usage.','Feature and route associations are candidates, not proof of root cause.','Detailed evidence is a bounded selection of peak and recent intervals, not every interval.','High call frequency or errors alone do not prove a loop. No automatic remediation.']}
  } finally {busy=false}
}
