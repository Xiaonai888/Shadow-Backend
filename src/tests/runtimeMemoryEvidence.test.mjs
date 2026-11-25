import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeMemoryEvidenceTracker } from '../services/runtimeMemoryEvidence.service.js'

function runtime(entries = 10) {
  return {
    pressure: 'protect',
    process: { rss_mb: 360, heap_used_mb: 100, active_resource_counts: { Timeout: 12 } },
    container: { total_mb: 360, limit_mb: 512, cgroup_breakdown: { currentMb: 350, anonymousMb: 320 } },
    inspectables: [{ name: 'Test Cache', mode: 'ttl_cache', state: 'cached', entries, request_in_flight: false, private_payload: { secret: true }, access_token: 'private' }],
  }
}

test('captures bounded context without retaining cache data or job identity', () => {
  const tracker = createRuntimeMemoryEvidenceTracker()
  const source = runtime()
  const context = tracker.capture({
    runtime: source,
    telemetry: { runningCount: 1, running: [{ jobType: 'media', jobTag: 'private-id', state: 'running' }] },
    activeRoutes: [{ route: 'GET /api/admin/work/events', count: 2, oldest_age_ms: 10000 }],
    activeRequestCount: 2,
    now: 1000,
  })
  source.inspectables[0].entries = 999
  assert.equal(context.inspectables[0].metrics.entries, 10)
  assert.equal(context.inspectables[0].metrics.private_payload, undefined)
  assert.equal(context.inspectables[0].metrics.access_token, undefined)
  assert.equal(context.tracked_jobs.running[0].jobTag, undefined)
  assert.equal(context.requests.routes[0].count, 2)
  assert.equal(context.container.current_mb, 350)
})

test('compares registered counters between incidents', () => {
  const tracker = createRuntimeMemoryEvidenceTracker()
  tracker.capture({ runtime: runtime(10), now: 1000 })
  const current = tracker.capture({ runtime: runtime(42), now: 4000 })
  assert.equal(current.inspectables[0].delta_since_previous_context.entries, 32)
  assert.equal(current.previous_context_age_ms, 3000)
  assert.equal(current.tracked_jobs.available, false)
  assert.equal(current.process.external_mb, null)
})

test('caps history, registered sources, jobs and routes', () => {
  const tracker = createRuntimeMemoryEvidenceTracker()
  for (let i = 0; i < 20; i++) {
    const source = runtime(i)
    source.inspectables = Array.from({ length: 70 }, (_, index) => ({ name: `Cache ${index}`, entries: i }))
    tracker.capture({ runtime: source, telemetry: { runningCount: 30, running: Array(30).fill({ jobType: 'test' }), events: Array(30).fill({ jobType: 'test' }) }, activeRoutes: Array(30).fill({ route: 'GET /test', count: 1 }), now: 1000 + i })
  }
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.capture_count, 20)
  assert.equal(snapshot.retained_contexts, 8)
  assert.equal(snapshot.latest.inspectables.length, 48)
  assert.equal(snapshot.latest.inspectables_truncated, true)
  assert.equal(snapshot.latest.tracked_jobs.running.length, 12)
  assert.equal(snapshot.latest.tracked_jobs.recent_events.length, 16)
  assert.equal(snapshot.latest.requests.routes.length, 12)
  assert.equal(tracker.snapshot({ limit: 2 }).history.length, 2)
  assert.equal(tracker.capture({}), null)
})
