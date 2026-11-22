import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTHOR_PREORDER_LAUNCH_CHECK_KEYS,
  assessAuthorPreOrderLaunchReadiness,
} from '../src/services/authorPreOrderLaunchReadinessPolicy.service.js'

function snapshot(overrides = {}) {
  return {
    schema_version: 17,
    read_only: true,
    structural_only: true,
    gateway_payment_verified: false,
    integration_test_verified: false,
    ready_to_enable_payment: false,
    required_checks: AUTHOR_PREORDER_LAUNCH_CHECK_KEYS.length,
    checks: Object.fromEntries(AUTHOR_PREORDER_LAUNCH_CHECK_KEYS.map(key => [key, true])),
    missing: [],
    structure_complete: true,
    checked_at: '2026-11-22T10:00:00.000Z',
    ...overrides,
  }
}

test('all nineteen structural checks still cannot authorize payment activation', () => {
  assert.equal(AUTHOR_PREORDER_LAUNCH_CHECK_KEYS.length, 19)
  const result = assessAuthorPreOrderLaunchReadiness(snapshot())
  assert.equal(result.structure_complete, true)
  assert.equal(result.passed_checks, 19)
  assert.equal(result.ready_to_enable_payment, false)
  assert.equal(result.requires_gateway_verification, true)
  assert.equal(result.requires_integration_tests, true)
  assert.equal(result.read_only, true)
})

test('a missing database function is reported as a blocker', () => {
  const checks = snapshot().checks
  checks.finalization_rpc = false
  const result = assessAuthorPreOrderLaunchReadiness(snapshot({
    checks,
    missing: ['finalization_rpc'],
    structure_complete: false,
  }))
  assert.deepEqual(result.missing_checks, ['finalization_rpc'])
  assert.equal(result.status, 'missing_database_dependencies')
})

test('incorrect or forged missing list is rejected', () => {
  const checks = snapshot().checks
  checks.checkout_rpc = false
  assert.throws(() => assessAuthorPreOrderLaunchReadiness(snapshot({ checks })), {
    code: 'PRE_ORDER_LAUNCH_SNAPSHOT_INVALID',
  })
  assert.throws(() => assessAuthorPreOrderLaunchReadiness(snapshot({
    missing: ['orders_table'],
  })), { code: 'PRE_ORDER_LAUNCH_SNAPSHOT_INVALID' })
})

test('untrusted declarations cannot mark production verification complete', () => {
  for (const extra of [
    { gateway_payment_verified: true },
    { integration_test_verified: true },
    { ready_to_enable_payment: true },
    { read_only: false },
    { structural_only: false },
    { schema_version: 16 },
  ]) {
    assert.throws(() => assessAuthorPreOrderLaunchReadiness(snapshot(extra)), {
      code: 'PRE_ORDER_LAUNCH_SNAPSHOT_INVALID',
    })
  }
})

test('unknown check state, invalid timestamp and duplicate missing checks are rejected', () => {
  const checks = snapshot().checks
  checks.stock_snapshot_rpc = null
  assert.throws(() => assessAuthorPreOrderLaunchReadiness(snapshot({ checks })), {
    code: 'PRE_ORDER_LAUNCH_SNAPSHOT_INVALID',
  })
  assert.throws(() => assessAuthorPreOrderLaunchReadiness(snapshot({
    checked_at: 'not-a-date',
  })), { code: 'PRE_ORDER_LAUNCH_SNAPSHOT_INVALID' })
  assert.throws(() => assessAuthorPreOrderLaunchReadiness(snapshot({
    missing: ['orders_table', 'orders_table'],
  })), { code: 'PRE_ORDER_LAUNCH_SNAPSHOT_INVALID' })
})
