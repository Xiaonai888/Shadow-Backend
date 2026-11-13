import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resourceCostCumulativeDelta,
  resourceCostNonnegativeInteger,
  resourceCostRange,
  resourceCostRenderReconciliation,
  resourceCostUtcHour,
} from '../services/resourceCostMath.service.js'
import {
  saveResourceCostProviderObservations,
  readResourceCostProviderObservations,
} from '../services/resourceCostProviderLedger.service.js'
import {
  flushResourceCostUploadAudit,
  getResourceCostUploadAuditHealth,
  recordResourceCostUpload,
} from '../services/resourceCostUploadAudit.service.js'

test('UTC buckets and ranges are precise', () => {
  assert.equal(resourceCostUtcHour('2026-11-13T11:59:59+07:00'), '2026-11-13T04:00:00.000Z')
  assert.equal(resourceCostRange('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z').from, '2026-11-01T00:00:00.000Z')
  assert.throws(() => resourceCostRange('2026-11-13', '2026-11-12'), RangeError)
  assert.throws(() => resourceCostNonnegativeInteger(-1), TypeError)
})

test('cumulative readings cannot silently turn into negative usage', () => {
  const base = { provider: 'cloudflare_r2', metric: 'class_a_ops', scope: 'account', kind: 'cumulative', unit: 'requests', period_start: '2026-11-01T00:00:00Z' }
  const before = { ...base, value: 150, observed_hour: '2026-11-13T04:00:00Z' }
  assert.deepEqual(resourceCostCumulativeDelta(before, { ...base, value: 165, observed_hour: '2026-11-13T05:00:00Z' }), { delta: 15, status: 'ok' })
  assert.equal(resourceCostCumulativeDelta(before, { ...base, value: 3, observed_hour: '2026-11-13T05:00:00Z' }).status, 'counter_reset')
  assert.equal(resourceCostCumulativeDelta(before, { ...base, value: 160, observed_hour: '2026-11-13T04:00:00Z' }).status, 'out_of_order')
})

test('Render app attribution remains an estimate and needs aligned windows', () => {
  assert.equal(resourceCostRenderReconciliation({ providerBytes: 400, httpPayloadBytes: 100, externalRequestBytes: 200 }).status, 'not_comparable')
  const result = resourceCostRenderReconciliation({ providerBytes: 400, httpPayloadBytes: 100, externalRequestBytes: 200, sameWindow: true, completeProviderWindow: true })
  assert.equal(result.gap_bytes_estimate, 100)
  assert.equal(result.excess_observed_bytes, 0)
  assert.equal(result.status, 'estimated_application_attribution')
})

test('provider observations preserve the newest sample for the same hour', async () => {
  const captured = []
  const mock = { rpc: async (name, args) => { captured.push({ name, args }); return { data: 1, error: null } } }
  const base = {
    provider: 'render', metric: 'outbound_bytes', scope: 'srv_test', kind: 'interval', unit: 'bytes',
    periodStart: '2026-11-13T10:00:00Z', periodEnd: '2026-11-13T11:00:00Z', status: 'ok',
  }
  const answer = await saveResourceCostProviderObservations([
    { ...base, value: 1000, observedAt: '2026-11-13T11:01:00Z' },
    { ...base, value: 1100, observedAt: '2026-11-13T11:18:00Z' },
  ], mock)
  assert.equal(answer.rows, 1)
  assert.equal(captured[0].name, 'resource_cost_save_provider_observations')
  assert.equal(captured[0].args.p_rows[0].value, 1100)
  await assert.rejects(() => saveResourceCostProviderObservations([{ ...base, value: -5 }], mock), TypeError)
})

test('provider history returns explicit pagination rather than truncating silently', async () => {
  const calls = []
  const chain = {
    select(...args) { calls.push(['select', ...args]); return this },
    gte(...args) { calls.push(['gte', ...args]); return this },
    lt(...args) { calls.push(['lt', ...args]); return this },
    order(...args) { calls.push(['order', ...args]); return this },
    range(...args) { calls.push(['range', ...args]); return this },
    eq(...args) { calls.push(['eq', ...args]); return this },
    then(resolve) { return Promise.resolve({ data: [{ id: 1 }, { id: 2 }, { id: 3 }], error: null }).then(resolve) },
  }
  const mock = { from: () => chain }
  const result = await readResourceCostProviderObservations({ from: '2026-11-13T10:30:00Z', to: '2026-11-13T12:00:00Z', provider: 'render', limit: 2 }, mock)
  assert.equal(result.rows.length, 2)
  assert.equal(result.has_more, true)
  assert.equal(result.next_offset, 2)
  assert.ok(calls.some((item) => item[0] === 'gte' && item[1] === 'observed_at'))
})

test('upload audit keeps aggregated counters and retry uses one batch ID', async () => {
  const observedAt = '2026-11-13T11:22:30Z'
  recordResourceCostUpload({ feature: 'novel', route: 'episode_image', mode: 'proxy', status: 'success', occurredAt: observedAt, ingressBytes: 700, egressBytes: 300, objectBytes: 300 })
  recordResourceCostUpload({ feature: 'novel', route: 'episode_image', mode: 'proxy', status: 'failure', occurredAt: observedAt, ingressBytes: 100 })
  let firstId
  await assert.rejects(() => flushResourceCostUploadAudit(async (batch) => {
    firstId = batch.id
    assert.equal(batch.rows.length, 1)
    assert.equal(batch.rows[0].attempts, 2)
    assert.equal(batch.rows[0].successes, 1)
    assert.equal(batch.rows[0].failures, 1)
    assert.equal(batch.rows[0].ingress_bytes, 800)
    throw new Error('Temporary database error')
  }), /Temporary/)
  const health = getResourceCostUploadAuditHealth()
  assert.equal(health.pending_batches, 1)
  const success = await flushResourceCostUploadAudit(async (batch) => {
    assert.equal(batch.id, firstId)
    return { applied: true }
  })
  assert.equal(success.batch_id, firstId)
  assert.equal(getResourceCostUploadAuditHealth().pending_attempts, 0)
  assert.equal((await flushResourceCostUploadAudit()).status, 'empty')
})
