import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTHOR_PREORDER_LAUNCH_CHECK_KEYS,
  assessAuthorPreOrderLaunchReadiness,
} from '../src/services/authorPreOrderLaunchReadinessPolicy.service.js'

function snapshot(overrides = {}) {
  return {
    schema_version: 17,
    required_checks: AUTHOR_PREORDER_LAUNCH_CHECK_KEYS.length,
    checks: Object.fromEntries(AUTHOR_PREORDER_LAUNCH_CHECK_KEYS.map(key => [key, true])),
    missing: [],
    structure_complete: true,
    structural_only: true,
    gateway_payment_verified: false,
    integration_test_verified: false,
    ready_to_enable_payment: false,
    read_only: true,
    checked_at: '2026-11-22T10:00:00Z',
    ...overrides,
  }
}

test('complete catalog still blocks activation until live verification', () => {
  const result = assessAuthorPreOrderLaunchReadiness(snapshot())
  assert.equal(result.structure_complete, true)
  assert.equal(result.ready_to_enable_payment, false)
  assert.equal(result.status, 'awaiting_live_verification')
  assert.equal(result.total_checks, 19)
})

test('missing database function becomes explicit blocker', () => {
  const base = snapshot()
  base.checks.checkout_rpc = false
  base.missing = ['checkout_rpc']
  base.structure_complete = false
  const result = assessAuthorPreOrderLaunchReadiness(base)
  assert.deepEqual(result.missing_checks, ['checkout_rpc'])
  assert.equal(result.ready_to_enable_payment, false)
})

test('reject missing check flag', () => {
  const base = snapshot()
  delete base.checks.terminal_release_rpc
  assert.throws(() => assessAuthorPreOrderLaunchReadiness(base), { code: 'PRE_ORDER_LAUNCH_SNAPSHOT_INVALID' })
})

test('reject inconsistent missing list', () => {
  assert.throws(() => assessAuthorPreOrderLaunchReadiness(snapshot({ missing: ['checkout_rpc'] })),
    { code: 'PRE_ORDER_LAUNCH_SNAPSHOT_INVALID' })
})

test('reject duplicate missing list', () => {
  const base = snapshot()
  base.checks.checkout_rpc = false
  base.missing = ['checkout_rpc', 'checkout_rpc']
  base.structure_complete = false
  assert.throws(() => assessAuthorPreOrderLaunchReadiness(base), { code: 'PRE_ORDER_LAUNCH_SNAPSHOT_INVALID' })
})

test('reject attempt to claim gateway verified through snapshot', () => {
  assert.throws(() => assessAuthorPreOrderLaunchReadiness(snapshot({ gateway_payment_verified: true })),
    { code: 'PRE_ORDER_LAUNCH_SNAPSHOT_INVALID' })
})

test('reject attempt to claim launch permission through snapshot', () => {
  assert.throws(() => assessAuthorPreOrderLaunchReadiness(snapshot({ ready_to_enable_payment: true })),
    { code: 'PRE_ORDER_LAUNCH_SNAPSHOT_INVALID' })
})

test('reject missing timestamp', () => {
  assert.throws(() => assessAuthorPreOrderLaunchReadiness(snapshot({ checked_at: 'invalid' })),
    { code: 'PRE_ORDER_LAUNCH_SNAPSHOT_INVALID' })
})

test('reject bad schema version', () => {
  assert.throws(() => assessAuthorPreOrderLaunchReadiness(snapshot({ schema_version: 16 })),
    { code: 'PRE_ORDER_LAUNCH_SNAPSHOT_INVALID' })
})

test('reject incomplete read-only guarantee', () => {
  assert.throws(() => assessAuthorPreOrderLaunchReadiness(snapshot({ read_only: false })),
    { code: 'PRE_ORDER_LAUNCH_SNAPSHOT_INVALID' })
})
