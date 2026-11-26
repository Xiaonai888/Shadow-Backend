import React, { useEffect, useRef, useState } from 'react'
import { formatOptimizationBytes, formatOptimizationNumber, normalizeResourceOptimization } from './resourceOptimizationAdvisorModel'

const panel = { border: '1px solid #94a3b866', borderRadius: 12, padding: 16, minWidth: 0 }
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }
const button = { border: '1px solid #94a3b899', borderRadius: 8, padding: '8px 14px', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' }
const small = { fontSize: 12, opacity: 0.8 }

function Metric({ label, value }) {
  return <div style={panel}><div style={small}>{label}</div><strong style={{ fontSize: 22 }}>{value}</strong></div>
}

function Results({ data }) {
  const totals = data.totals
  const [filter, setFilter] = useState('ALL')
  const findings = data.findings.filter(row => filter === 'ALL' || row.type === filter)
  return <div style={{ display: 'grid', gap: 16 }}>
    <div style={small}>{data.historical ? 'Stored 15-minute snapshots' : 'Live backend evidence'} · {data.from || '—'} to {data.to || '—'}</div>
    {data.status === 'unavailable' && <div role="status" style={panel}>No observations are available for this period. Missing data is not zero usage.</div>}
    {data.status === 'partial' && <div role="status" style={panel}>Historical coverage is incomplete. Results cover available snapshots only.</div>}
    <div style={grid}>
      <Metric label="Observed HTTP and REST reads" value={formatOptimizationNumber(totals?.observations)} />
      <Metric label="Repeated signatures" value={formatOptimizationNumber(totals?.repeated_signatures)} />
      <Metric label="Cross-page repeats" value={formatOptimizationNumber(totals?.cross_page_repeats)} />
      <Metric label="Observed repeat response bytes" value={formatOptimizationBytes(totals?.repeat_response_bytes)} />
      <Metric label="Supabase calls on repeated HTTP" value={formatOptimizationNumber(totals?.repeat_supabase_calls)} />
      <Metric label="Backend cache hits" value={formatOptimizationNumber(totals?.cache_hits)} />
    </div>
    <div style={panel}>
      <strong>Coverage and interpretation</strong>
      <p style={small}>{data.note || 'Review candidates only. These metrics do not prove avoidable work or billed savings.'}</p>
      <p style={small}>HTTP monitoring covers selected GET routes. Supabase monitoring covers successful REST reads inside the same request. Client-side cache hits and unobserved traffic are not measured here.</p>
      {data.detailCapped && <p role="status" style={small}>Detail is capped. Totals may include more observations than the visible rows.</p>}
      {!data.historical && <div style={small}>Dropped rows: {formatOptimizationNumber(data.coverage.dropped_rows)} · Dropped recent keys: {formatOptimizationNumber(data.coverage.dropped_recent)} · Dropped database keys: {formatOptimizationNumber(data.coverage.dropped_db_keys)}</div>}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
      <strong>Review findings ({findings.length})</strong>
      <label style={small}>Type <select value={filter} onChange={event => setFilter(event.target.value)} style={{ ...button, marginLeft: 6, background: 'Canvas', color: 'CanvasText' }}>
        <option value="ALL">All</option>
        <option value="SHARED_DATA_OPPORTUNITY">Shared Data</option>
        <option value="REPEATED_HTTP_SIGNATURE">HTTP Requests</option>
        <option value="REPEATED_SUPABASE_READ">Supabase Reads</option>
      </select></label>
    </div>
    {findings.length === 0 && <div style={panel}>No review findings in the available evidence for this filter.</div>}
    {findings.map((item, index) => <article key={`${item.type}:${item.route}:${item.page}:${index}`} style={{ ...panel, overflowWrap: 'anywhere' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}><strong>{item.label}</strong><span style={small}>Review required</span></div>
      <div style={{ marginTop: 8 }}><code>{item.route}</code></div>
      <div style={small}>{item.page}</div>
      <div style={{ ...grid, marginTop: 12 }}>
        <div><span style={small}>Observations</span><div>{formatOptimizationNumber(item.observations)}</div></div>
        <div><span style={small}>Repeated signatures</span><div>{formatOptimizationNumber(item.repeated)}</div></div>
        {item.type === 'SHARED_DATA_OPPORTUNITY' && <div><span style={small}>Cross-page repeats</span><div>{formatOptimizationNumber(item.crossPage)}</div></div>}
        {item.type !== 'REPEATED_SUPABASE_READ' && <div><span style={small}>Repeat response bytes</span><div>{formatOptimizationBytes(item.bytes)}</div></div>}
      </div>
      {item.action && <p><strong>Recommended review: </strong>{item.action}</p>}
      {item.safety && <p style={{ ...small, marginBottom: 0 }}><strong>Safety check: </strong>{item.safety}</p>}
    </article>)}
  </div>
}

export default function ResourceOptimizationAdvisor({ loadOptimization, historyOptimization = null }) {
  const [live, setLive] = useState(null)
  const [mode, setMode] = useState('live')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(null)
  useEffect(() => () => { active.current?.abort(); active.current = null }, [])

  async function refresh() {
    if (active.current || typeof loadOptimization !== 'function') return
    const controller = new AbortController()
    active.current = controller
    setLoading(true)
    setError('')
    try {
      const payload = await loadOptimization({ signal: controller.signal })
      const result = normalizeResourceOptimization(payload)
      if (active.current === controller && !controller.signal.aborted) setLive(result)
    } catch {
      if (active.current === controller && !controller.signal.aborted) setError('Unable to load Optimization Advisor. Check Admin permission, connection and Backend deployment.')
    } finally {
      if (active.current === controller) { active.current = null; setLoading(false) }
    }
  }

  let history = null
  let historyInvalid = false
  if (historyOptimization) {
    try { history = normalizeResourceOptimization(historyOptimization) } catch { historyInvalid = true }
  }
  const data = mode === 'history' ? history : live
  return <section aria-label="Optimization Advisor" style={{ display: 'grid', gap: 16 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
      <div><h2 style={{ margin: 0, fontSize: 20 }}>Optimization Advisor</h2><div style={small}>Shared data, duplicate reads and cache opportunities</div></div>
      {mode === 'live' && <button type="button" style={button} disabled={loading || typeof loadOptimization !== 'function'} onClick={refresh}>{loading ? 'Loading…' : live ? 'Refresh' : 'Load live data'}</button>}
    </div>
    <div style={{ display: 'flex', gap: 8 }}>
      <button type="button" style={{ ...button, fontWeight: mode === 'live' ? 700 : 400 }} aria-pressed={mode === 'live'} onClick={() => setMode('live')}>Live</button>
      <button type="button" style={{ ...button, fontWeight: mode === 'history' ? 700 : 400 }} aria-pressed={mode === 'history'} onClick={() => setMode('history')}>History</button>
    </div>
    {mode === 'live' && error && <div role="alert" style={panel}>{error}{live ? ' Showing the previous successful result.' : ''}</div>}
    {mode === 'live' && !data && !error && <div style={panel}>Load live data when needed. There is no automatic polling.</div>}
    {mode === 'history' && !data && <div role="status" style={panel}>{historyInvalid ? 'History response is unsupported.' : 'Select a date range in System Control to view existing stored evidence.'}</div>}
    {data && <Results key={mode} data={data} />}
  </section>
}
