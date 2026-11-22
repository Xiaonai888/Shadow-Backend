import { preOrderError } from './authorPreOrderValidation.service.js'

export const AUTHOR_PREORDER_LAUNCH_CHECK_KEYS = Object.freeze([
  'orders_table',
  'order_items_table',
  'payment_intents_table',
  'legacy_holds_table',
  'multi_holds_table',
  'notification_outbox_table',
  'multi_hold_rls_enabled',
  'outbox_rls_enabled',
  'stock_snapshot_rpc',
  'checkout_rpc',
  'finalization_rpc',
  'uninitialized_release_rpc',
  'terminal_release_rpc',
  'notification_settlement_rpc',
  'notification_queue_rpc',
  'notification_worker_rpc',
  'notification_reference_unique_index',
  'audit_rpc',
  'terminal_review_rpc',
])

function invalid() {
  throw preOrderError('PRE_ORDER_LAUNCH_SNAPSHOT_INVALID', 'Launch readiness snapshot is incomplete', 503)
}

export function assessAuthorPreOrderLaunchReadiness(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      snapshot.schema_version !== 17 || snapshot.read_only !== true ||
      snapshot.structural_only !== true || snapshot.gateway_payment_verified !== false ||
      snapshot.integration_test_verified !== false ||
      snapshot.ready_to_enable_payment !== false ||
      snapshot.required_checks !== AUTHOR_PREORDER_LAUNCH_CHECK_KEYS.length ||
      !snapshot.checks || typeof snapshot.checks !== 'object' ||
      Array.isArray(snapshot.checks) || !Array.isArray(snapshot.missing)) {
    invalid()
  }

  const missing = AUTHOR_PREORDER_LAUNCH_CHECK_KEYS.filter(key => {
    if (typeof snapshot.checks[key] !== 'boolean') invalid()
    return !snapshot.checks[key]
  })
  const declaredMissing = snapshot.missing
  if (declaredMissing.length !== missing.length ||
      new Set(declaredMissing).size !== declaredMissing.length ||
      declaredMissing.some(key => typeof key !== 'string' || !missing.includes(key)) ||
      snapshot.structure_complete !== (missing.length === 0)) {
    invalid()
  }

  const checkedAt = Date.parse(String(snapshot.checked_at || ''))
  if (!Number.isFinite(checkedAt)) invalid()

  return {
    schema_version: 17,
    structure_complete: missing.length === 0,
    missing_checks: missing,
    passed_checks: AUTHOR_PREORDER_LAUNCH_CHECK_KEYS.length - missing.length,
    total_checks: AUTHOR_PREORDER_LAUNCH_CHECK_KEYS.length,
    status: missing.length === 0 ? 'awaiting_live_verification' : 'missing_database_dependencies',
    ready_to_enable_payment: false,
    requires_gateway_verification: true,
    requires_integration_tests: true,
    read_only: true,
    checked_at: new Date(checkedAt).toISOString(),
  }
}
