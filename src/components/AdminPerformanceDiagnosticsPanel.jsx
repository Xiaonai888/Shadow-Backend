import React, { useState } from 'react'

const count = (value) => Math.max(0, Number(value) || 0).toLocaleString()
const milliseconds = (value) => `${Math.round(Math.max(0, Number(value) || 0)).toLocaleString()} ms`

const statusText = {
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
  OBSERVATIONS_AVAILABLE: 'Observations available',
}

const categoryText = {
  EXTERNAL_ERROR_OBSERVED: 'External error observed',
  SLOW_EXTERNAL_CALL_OBSERVED: 'Slow external call observed',
  SLOW_BACKEND_UNATTRIBUTED: 'Backend delay, source unknown',
  SERVER_ERROR_UNATTRIBUTED: 'Server error, source unknown',
  INSUFFICIENT_EVIDENCE: 'Source not identified',
}

function Metric({ title, value, note }) {
  return (
    <div style={{ border: '1px solid #E2E8F0', borderRadius: 12, padding: 12, background: '#FFF' }}>
      <div style={{ color: '#64748B', fontSize: 11, fontWeight: 700 }}>{title}</div>
      <div style={{ color: '#0F172A', fontSize: 22, fontWeight: 800, marginTop: 5 }}>{value}</div>
      <div style={{ color: '#64748B', fontSize: 10, marginTop: 5 }}>{note}</div>
    </div>
  )
}

export default function AdminPerformanceDiagnosticsPanel({ diagnostics }) {
  const [copied, setCopied] = useState(false)
  const report = diagnostics && typeof diagnostics === 'object' ? diagnostics : null
  const coverage = report?.coverage || {}
  const totals = report?.totals || {}
  const samples = Array.isArray(report?.slow_request_evidence)
    ? report.slow_request_evidence.slice(0, 12)
    : []
  const causes = Array.isArray(report?.sample_cause_groups)
    ? report.sample_cause_groups.slice(0, 8)
    : []
  const routes = Array.isArray(report?.route_performance)
    ? report.route_performance.slice(0, 10)
    : []

  const handleCopy = async () => {
    if (!report || !navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className="sc-block" aria-label="Backend Performance Diagnostics">
      <div className="sc-block-head">
        <div className="sc-block-title-wrap">
          <span className="sc-icon blue">P</span>
          <div>
            <div className="sc-block-title">Performance Diagnostics</div>
            <div className="sc-block-subtitle">
              Backend API evidence only · Read-only · No additional monitoring requests
            </div>
          </div>
        </div>
        {report && (
          <button type="button" className="sc-detail-btn" onClick={handleCopy}>
            {copied ? 'Copied' : 'Copy Evidence'}
          </button>
        )}
      </div>

      {!report ? (
        <div className="sc-empty">
          No performance diagnostics returned. Deploy Backend step 1, then refresh System Control.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 16, padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="sc-pill low">{statusText[report.result] || 'Evidence not classified'}</span>
            <span style={{ color: '#64748B', fontSize: 11 }}>
              Window: last {count(coverage.request_summary_window_minutes || 60)} minutes
            </span>
            <span style={{ color: '#64748B', fontSize: 11 }}>
              Updated: {report.generated_at ? new Date(report.generated_at).toLocaleString() : 'Unknown'}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(145px,1fr))', gap: 10 }}>
            <Metric title="Observed API requests" value={count(totals.observed_requests_in_page_monitor)} note="Requests in page monitor" />
            <Metric title="Slow / failed samples" value={count(coverage.sampled_slow_or_failed_count)} note="Selected samples, not all traffic" />
            <Metric title="Supabase calls" value={count(totals.observed_supabase_calls)} note="Calls observed by Backend" />
            <Metric title="Server errors (5xx)" value={count(totals.observed_5xx)} note="Within available coverage" />
          </div>

          <div style={{ border: '1px solid #E2E8F0', borderRadius: 12, padding: 12 }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: '#0F172A' }}>Observed patterns (not confirmed root causes)</div>
            {causes.length ? (
              <div style={{ display: 'grid', gap: 9, marginTop: 10 }}>
                {causes.map((item, index) => (
                  <div key={`${item.category}-${item.provider}-${index}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', color: '#334155', fontSize: 12 }}>
                    <span>{categoryText[item.category] || item.category} · {item.provider || 'Unknown'}</span>
                    <strong>{count(item.sampled_requests)} samples · max {milliseconds(item.longest_response_ms)}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: '#64748B', fontSize: 12, marginTop: 8 }}>
                No matching slow or failed samples captured yet. This does not prove the website is fast.
              </div>
            )}
          </div>

          <div>
            <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8, color: '#0F172A' }}>API routes by average response time</div>
            {routes.length ? (
              <div style={{ overflowX: 'auto', border: '1px solid #E2E8F0', borderRadius: 12 }}>
                <table style={{ width: '100%', minWidth: 570, borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead style={{ background: '#F8FAFC', color: '#475569' }}>
                    <tr>
                      {['Route', 'Requests', 'Avg', 'Max observed', 'DB / request', '5xx'].map((label) => (
                        <th key={label} style={{ textAlign: label === 'Route' ? 'left' : 'right', padding: 10, borderBottom: '1px solid #E2E8F0' }}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {routes.map((route, index) => (
                      <tr key={`${route.route}-${index}`} style={{ borderBottom: '1px solid #F1F5F9' }}>
                        <td style={{ padding: 10, overflowWrap: 'anywhere', color: '#334155' }}>{route.route || 'Unknown'}</td>
                        <td style={{ textAlign: 'right', padding: 10 }}>{count(route.requests)}</td>
                        <td style={{ textAlign: 'right', padding: 10 }}>{milliseconds(route.average_duration_ms)}</td>
                        <td style={{ textAlign: 'right', padding: 10 }}>{milliseconds(route.observed_slowest_request_ms)}</td>
                        <td style={{ textAlign: 'right', padding: 10 }}>{Number(route.supabase_calls_per_request || 0).toFixed(2)}</td>
                        <td style={{ textAlign: 'right', padding: 10 }}>{count(route.errors_5xx)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ color: '#64748B', fontSize: 12 }}>No API route timing is available yet.</div>
            )}
          </div>

          <div>
            <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8, color: '#0F172A' }}>Slow request evidence</div>
            {samples.length ? (
              <div style={{ display: 'grid', gap: 8 }}>
                {samples.map((sample, index) => (
                  <div key={`${sample.request_id || 'sample'}-${index}`} style={{ border: '1px solid #E2E8F0', borderRadius: 12, padding: 11, color: '#334155', fontSize: 11 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                      <strong style={{ overflowWrap: 'anywhere' }}>{sample.route || 'Unknown route'}</strong>
                      <strong>{milliseconds(sample.response_duration_ms)} · HTTP {sample.http_status}</strong>
                    </div>
                    <div style={{ marginTop: 5 }}>{categoryText[sample.evidence_category] || 'Unclassified'} · confidence: {sample.confidence || 'low'}</div>
                    <div style={{ marginTop: 4, color: '#64748B', overflowWrap: 'anywhere' }}>{sample.explanation || 'No explanation available.'}</div>
                    {sample.slowest_observed_target && (
                      <div style={{ marginTop: 4, overflowWrap: 'anywhere' }}>
                        Slowest observed target: {sample.slowest_observed_target.target} · avg {milliseconds(sample.slowest_observed_target.average_duration_ms)}
                      </div>
                    )}
                    <div style={{ marginTop: 5, color: '#64748B' }}>
                      {sample.time ? new Date(sample.time).toLocaleString() : 'Unknown time'} · {sample.request_id || 'No request ID'} · Cache {sample.cache || 'NOT_RECORDED'}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: '#64748B', fontSize: 12 }}>No individual slow request evidence available in the current sample window.</div>
            )}
          </div>

          <div style={{ background: '#F8FAFC', borderRadius: 12, padding: 12, color: '#475569', fontSize: 11, lineHeight: 1.65 }}>
            <strong style={{ color: '#334155' }}>Evidence limitations:</strong> Sampled requests cannot establish p95/p99 or prove causation. Overlapping dependency times cannot be subtracted from total duration. Images fetched directly from Cloudflare R2 by the browser are not measured here. Additional browser image timings, Render CPU/RAM and Supabase query timings are needed before naming a confirmed root cause.
          </div>
        </div>
      )}
    </section>
  )
}
