const clean=v=>String(v??'Unavailable').replace(/[\r\n\t|<>]/g,' ').slice(0,240)
const number=v=>typeof v==='number'&&Number.isFinite(v)?v.toLocaleString('en-US',{maximumFractionDigits:2}):'Unavailable'
const bytes=v=>typeof v==='number'&&Number.isFinite(v)?`${number(v/1048576)} MiB`:'Unavailable'
const format=(k,v)=>k.endsWith('_bytes')?bytes(v):number(v)
const fields=['read_bytes','written_bytes','wal_bytes','temp_written_bytes','calls','exec_ms']
export function formatDatabaseIoReport(report) {
  const out=['# Shadow Database IO Evidence Report','',`Generated: ${clean(report.generated_at)}`,`UTC range: ${clean(report.range.from)} to ${clean(report.range.to)}`,'Mode: Monitoring only','', '## Coverage']
  for(const [k,v] of Object.entries(report.coverage))out.push(`- ${clean(k)}: ${number(v)}`)
  out.push('','## Observed totals')
  for(const [k,v] of Object.entries(report.totals))out.push(`- ${clean(k)}: ${format(k,v)}`)
  out.push('','## Largest measured feature contributors')
  for(const k of fields) {
    out.push('',`### ${k}`)
    const rows=report.rankings[k]||[]
    if(!rows.length)out.push('No positive measured values in retained data.')
    for(const r of rows)out.push(`- ${clean(r.feature)}: ${format(k,r[k])}`)
  }
  out.push('','## Detailed evidence (selected intervals)')
  for(const r of report.details) {
    out.push('',`### ${clean(r.from)} to ${clean(r.to)}`,`Status: ${clean(r.status)}; traffic: ${clean(r.traffic_evidence?.status)}`)
    if(r.status==='detail_unavailable')continue
    for(const k of fields) {
      const top=[...(r.top_queries||[])].filter(q=>(q[k]??0)>0).sort((a,b)=>b[k]-a[k]).slice(0,3)
      for(const q of top)out.push(`- ${k}: ${format(k,q[k])}; query ${clean(q.query_key)}; feature ${clean(q.feature)}; identifiers ${clean(q.targets?.join(', '))}; calls ${number(q.calls)}; mean ms ${number(q.mean_exec_ms)}; buffer read per call ${bytes(q.read_bytes_per_call)}`)
    }
    for(const q of r.attribution?.query_route_candidates?.filter(q=>q.candidate_count>0).slice(0,8)||[])for(const c of q.candidates.slice(0,2))out.push(`- Candidate association: query ${clean(q.query_key)} → ${clean(c.route)} → ${clean(c.target)}; calls ${number(c.calls)}; errors ${number(c.errors)}. Identifier match only.`)
    for(const c of r.attribution?.observed_failed_calls?.slice(0,5)||[])out.push(`- Observed failed calls: ${clean(c.route)} → ${clean(c.target)}; errors ${number(c.errors)}/${number(c.calls)}; 504s ${number(c.gateway_timeouts)}`)
    for(const c of r.attribution?.background_targets?.slice(0,5)||[])out.push(`- Background activity: ${clean(c.target)}; calls ${number(c.calls)}; errors ${number(c.errors)}; worker identity not established.`)
  }
  out.push('','## Archive coverage',...report.archive_coverage.map(r=>`- ${clean(r.day)}: ${clean(r.status)}`),'','## Interpretation and limitations',...report.limitations.map(x=>`- ${clean(x)}`),'','## Manual verification','- Compare high calls versus IO per call. Review polling and retry configuration if repeated calls occur.','- Examine query plans for high read or temporary writes using safe EXPLAIN first. Do not run EXPLAIN ANALYZE on production writes.','- Correlate timestamps with deployments, worker schedules and provider Disk IO charts.','- No fault, loop, or exact physical disk attribution is asserted from frequency alone.','')
  return out.join('\n')
}
