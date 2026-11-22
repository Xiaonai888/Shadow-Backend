import { getAuthorPreOrderPaymentAvailability } from './authorPreOrderPaymentAvailability.service.js'
import { probeAuthorPreOrderLaunchReadiness } from './authorPreOrderLaunchReadinessProbe.service.js'

const PROVIDER_ENV_KEYS = Object.freeze([
  'ABA_PAYWAY_MERCHANT_ID',
  'ABA_PAYWAY_API_KEY',
  'ABA_PAYWAY_PREORDER_CALLBACK_URL',
  'SHADOW_BACKEND_PUBLIC_ORIGIN',
])

export async function inspectAuthorPreOrderLaunchReadiness() {
  const schema = await probeAuthorPreOrderLaunchReadiness()
  const capabilities = getAuthorPreOrderPaymentAvailability()
  const missingProviderConfig = PROVIDER_ENV_KEYS.filter(key =>
    typeof process.env[key] !== 'string' || !process.env[key].trim()
  )
  const enabled = capabilities.payment_enabled === true ||
    capabilities.can_create_order === true ||
    capabilities.can_start_payment === true ||
    capabilities.can_confirm_payment === true ||
    capabilities.inventory_reservation_enabled === true
  const blockers = [
    ...schema.missing_checks.map(key => `PRE_ORDER_LAUNCH_MISSING_${key.toUpperCase()}`),
    ...missingProviderConfig.map(key => `PRE_ORDER_LAUNCH_UNCONFIGURED_${key}`),
    ...(enabled ? ['PRE_ORDER_LAUNCH_PAYMENT_ALREADY_ENABLED'] : []),
  ]

  return {
    ...schema,
    status: blockers.length ? 'blocked' : 'awaiting_live_verification',
    blockers,
    missing_provider_config: missingProviderConfig,
    payment_currently_enabled: enabled,
    payment_activation_performed: false,
    ready_to_enable_payment: false,
    gateway_called: false,
    order_created: false,
    automatic_run_started: false,
    read_only: true,
  }
}
