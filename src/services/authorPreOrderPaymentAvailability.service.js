import { API_BASE_URL, getAuthToken } from '../config/api'

const ROOT = `${API_BASE_URL}/api/author-store/pre-orders`
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const PAYMENT_STATUSES = new Set(['pending', 'paid', 'failed', 'expired', 'refunded'])
const FULFILLMENT_STATUSES = new Set(['awaiting_payment', 'reserved', 'production', 'shipping', 'completed', 'cancelled', 'delayed'])

function statusError(message, code = 'READER_PRE_ORDER_STATUS_UNAVAILABLE', status = 0) {
  return Object.assign(new Error(String(message)), { code, status })
}

function validOrderId(value) {
  const id = String(value || '').trim()
  if (!UUID.test(id)) throw statusError('Invalid pre-order ID', 'READER_PRE_ORDER_INVALID_ORDER_ID', 400)
  return id
}

async function request(path, { signal } = {}) {
  const token = getAuthToken()
  if (!token) throw statusError('Please sign in to view your pre-orders', 'LOGIN_REQUIRED', 401)
  let response
  try {
    response = await fetch(`${ROOT}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw statusError('Could not connect to the pre-order status service')
  }
  if (getAuthToken() !== token) {
    throw statusError('Account changed. Reload to view your orders', 'READER_PRE_ORDER_ACCOUNT_CHANGED', 401)
  }
  const data = await response.json().catch(() => null)
  if (!response.ok || data?.ok !== true) {
    throw statusError(data?.message || `Could not load status (HTTP ${response.status})`, data?.code || 'READER_PRE_ORDER_STATUS_UNAVAILABLE', response.status)
  }
  return data
}

function validateOrder(value) {
  if (!value || !UUID.test(value.id) || !UUID.test(value.campaign_id) ||
      !PAYMENT_STATUSES.has(value.payment_status) || !FULFILLMENT_STATUSES.has(value.fulfillment_status) ||
      !Number.isFinite(Number(value.total_usd)) || Number(value.total_usd) < 0 || !Array.isArray(value.items)) {
    throw statusError('Unexpected pre-order status data', 'READER_PRE_ORDER_STATUS_INVALID_RESPONSE')
  }
  return value
}

export async function fetchReaderPreOrderPaymentCapabilities({ signal } = {}) {
  const result = await request('/payment-capabilities', { signal })
  const capabilities = result.capabilities
  if (!capabilities || capabilities.payment_enabled !== false ||
      capabilities.can_create_order !== false || capabilities.can_start_payment !== false ||
      capabilities.can_confirm_payment !== false || capabilities.inventory_reservation_enabled !== false) {
    throw statusError('Pre-order payment availability could not be verified', 'READER_PRE_ORDER_PAYMENT_UNVERIFIED')
  }
  return capabilities
}

export async function fetchReaderPreOrderMyOrders({ page = 1, limit = 12, signal } = {}) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 24) {
    throw statusError('Invalid order pagination', 'READER_PRE_ORDER_STATUS_INVALID_PAGE', 400)
  }
  const params = new URLSearchParams({ page: String(page), limit: String(limit) })
  const data = await request(`/my-orders?${params.toString()}`, { signal })
  if (!Array.isArray(data.orders) || typeof data.has_more !== 'boolean') {
    throw statusError('Unexpected pre-order list', 'READER_PRE_ORDER_STATUS_INVALID_RESPONSE')
  }
  return {
    orders: data.orders.map(validateOrder),
    page: data.page,
    limit: data.limit,
    total: Number(data.total) || 0,
    hasMore: data.has_more,
  }
}

export async function fetchReaderPreOrderOrderStatus(orderId, { signal } = {}) {
  const data = await request(`/my-orders/${validOrderId(orderId)}/status`, { signal })
  return validateOrder(data.order)
}
