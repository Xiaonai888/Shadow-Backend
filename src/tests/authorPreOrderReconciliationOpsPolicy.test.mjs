import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTHOR_PREORDER_RECON_OPS_MAX_BATCH,
  AUTHOR_PREORDER_RECON_OPS_COOLDOWN_MS,
  AUTHOR_PREORDER_RECON_OPS_HEALTH_CACHE_MS,
  validateAuthorPreOrderReconciliationOpsLimit,
  allocateAuthorPreOrderReconciliationOpsBatch,
  authorPreOrderReconciliationManualEnabled,
  requireAuthorPreOrderReconciliationManualEnabled,
  authorPreOrderReconciliationSafeErrorCode,
} from '../services/authorPreOrderReconciliationOpsPolicy.service.js'

test('limits enforce a small bounded batch and a ten-minute cooldown', () => {
  assert.equal(AUTHOR_PREORDER_RECON_OPS_MAX_BATCH, 10)
  assert.equal(AUTHOR_PREORDER_RECON_OPS_COOLDOWN_MS, 600000)
  assert.equal(AUTHOR_PREORDER_RECON_OPS_HEALTH_CACHE_MS, 60000)
  for (const invalid of [0, 1, 11, -1, NaN, 2.5, '4', null]) {
    assert.throws(() => validateAuthorPreOrderReconciliationOpsLimit(invalid), {
      code: 'PRE_ORDER_RECON_OPS_LIMIT_INVALID',
    })
  }
})

test('allocation never exceeds the requested number of orders', () => {
  for (let limit = 2; limit <= 10; limit += 1) {
    const result = allocateAuthorPreOrderReconciliationOpsBatch(limit)
    assert.equal(result.max_orders, limit)
    assert.equal(result.legacy_limit + result.volume_limit, limit)
    assert.ok(result.legacy_limit >= 1)
    assert.ok(result.volume_limit >= 1)
  }
})

test('manual reconciliation remains disabled unless explicitly enabled', () => {
  const previous = process.env.AUTHOR_PREORDER_RECONCILIATION_MANUAL_ENABLED
  try {
    delete process.env.AUTHOR_PREORDER_RECONCILIATION_MANUAL_ENABLED
    assert.equal(authorPreOrderReconciliationManualEnabled(), false)
    assert.throws(() => requireAuthorPreOrderReconciliationManualEnabled(), {
      code: 'PRE_ORDER_RECON_OPS_DISABLED',
    })
    process.env.AUTHOR_PREORDER_RECONCILIATION_MANUAL_ENABLED = 'false'
    assert.equal(authorPreOrderReconciliationManualEnabled(), false)
    process.env.AUTHOR_PREORDER_RECONCILIATION_MANUAL_ENABLED = 'true'
    assert.equal(authorPreOrderReconciliationManualEnabled(), true)
    assert.doesNotThrow(() => requireAuthorPreOrderReconciliationManualEnabled())
  } finally {
    if (previous === undefined) delete process.env.AUTHOR_PREORDER_RECONCILIATION_MANUAL_ENABLED
    else process.env.AUTHOR_PREORDER_RECONCILIATION_MANUAL_ENABLED = previous
  }
})

test('error descriptions do not leak arbitrary error messages', () => {
  assert.equal(authorPreOrderReconciliationSafeErrorCode({ code: 'PRE_ORDER_RECON_OPS_COOLDOWN' }),
    'PRE_ORDER_RECON_OPS_COOLDOWN')
  assert.equal(authorPreOrderReconciliationSafeErrorCode({ code: 'SECRETS_OR_OTHER_INTERNAL' }),
    'PRE_ORDER_RECON_OPS_UNEXPECTED')
  assert.equal(authorPreOrderReconciliationSafeErrorCode(new Error('sensitive detail')),
    'PRE_ORDER_RECON_OPS_UNEXPECTED')
})
