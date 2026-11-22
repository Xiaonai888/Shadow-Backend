import { getAuthorPreOrderPaymentAvailability } from './authorPreOrderPaymentAvailability.service.js'
import { probeAuthorPreOrderLaunchReadiness } from './authorPreOrderLaunchReadinessProbe.service.js'

const REQUIRED_PROVIDER_ENV_KEYS = Object.freeze([
  'ABA_PAYWAY_MERCHANT_ID',
  'ABA_PAYWAY_API_KEY',
  'ABA_PAYWAY_MODE',
  'ABA_PAYWAY_PREORDER_CALLBACK_URL',
  'SHADOW_BACKEND_PUBLIC_ORIGIN',
])

const QR_PATH = '/api/payment-gateway/v1/payments/generate-qr'
const CHECK_PATH = '/api/payment-gateway/v1/payments/check-transaction-2'
const CALLBACK_PATH = '/api/author-store/pre-orders/aba-callback'

function configured(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.search || url.hash) return null
    return url
  } catch {
    return null
  }
}

export function inspectAuthorPreOrderProviderConfig(env = process.env) {
  const missing = REQUIRED_PROVIDER_ENV_KEYS.filter(key => !configured(env[key]))
  const invalid = []
  const merchantId = configured(env.ABA_PAYWAY_MERCHANT_ID)
  if (merchantId && merchantId.length > 80) invalid.push('ABA_PAYWAY_MERCHANT_ID')

  const mode = configured(env.ABA_PAYWAY_MODE).toLowerCase()
  if (mode && !['sandbox', 'production', 'live'].includes(mode)) {
    invalid.push('ABA_PAYWAY_MODE')
  }

  const originText = configured(env.SHADOW_BACKEND_PUBLIC_ORIGIN)
  const callbackText = configured(env.ABA_PAYWAY_PREORDER_CALLBACK_URL)
  const origin = originText ? safeHttpsUrl(originText) : null
  const callback = callbackText ? safeHttpsUrl(callbackText) : null
  if (originText && (!origin || origin.pathname !== '/')) {
    invalid.push('SHADOW_BACKEND_PUBLIC_ORIGIN')
  }
  if (callbackText && (!callback || callback.pathname !== CALLBACK_PATH ||
      (origin && callback.origin !== origin.origin))) {
    invalid.push('ABA_PAYWAY_PREORDER_CALLBACK_URL')
  }

  const expectedHost = mode === 'production' || mode === 'live'
    ? 'checkout.payway.com.kh' : 'checkout-sandbox.payway.com.kh'
  const endpoints = [
    ['ABA_PAYWAY_QR_URL', QR_PATH],
    ['ABA_PAYWAY_CHECK_TRANSACTION_URL', CHECK_PATH],
  ]
  for (const [key, path] of endpoints) {
    const value = configured(env[key])
    if (!value) continue
    const url = safeHttpsUrl(value)
    if (!url || url.hostname !== expectedHost || url.pathname !== path) {
      invalid.push(key)
    }
  }

  return {
    provider_mode: mode || null,
    missing_provider_config: missing,
    invalid_provider_config: [...new Set(invalid)],
    provider_config_valid: missing.length === 0 && invalid.length === 0,
  }
}

export async function inspectAuthorPreOrderLaunchReadiness() {
  const schema = await probeAuthorPreOrderLaunchReadiness()
  const capabilities = getAuthorPreOrderPaymentAvailability()
  const config = inspectAuthorPreOrderProviderConfig()
  const enabled = capabilities.payment_enabled === true ||
    capabilities.can_create_order === true ||
    capabilities.can_start_payment === true ||
    capabilities.can_confirm_payment === true ||
    capabilities.inventory_reservation_enabled === true
  const blockers = [
    ...schema.missing_checks.map(key => `PRE_ORDER_LAUNCH_MISSING_${key.toUpperCase()}`),
    ...config.missing_provider_config.map(key => `PRE_ORDER_LAUNCH_UNCONFIGURED_${key}`),
    ...config.invalid_provider_config.map(key => `PRE_ORDER_LAUNCH_INVALID_${key}`),
    ...(enabled ? ['PRE_ORDER_LAUNCH_PAYMENT_ALREADY_ENABLED'] : []),
  ]

  return {
    ...schema,
    status: blockers.length ? 'blocked' : 'awaiting_live_verification',
    blockers,
    ...config,
    payment_currently_enabled: enabled,
    payment_activation_performed: false,
    ready_to_enable_payment: false,
    gateway_called: false,
    order_created: false,
    automatic_run_started: false,
    read_only: true,
  }
}
