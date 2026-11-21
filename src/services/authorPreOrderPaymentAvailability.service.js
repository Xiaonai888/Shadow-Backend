const PAYMENT_DISABLED = Object.freeze({
  payment_enabled: false,
  can_create_order: false,
  can_start_payment: false,
  can_confirm_payment: false,
  inventory_reservation_enabled: false,
  payment_provider: null,
  currency: 'USD',
  code: 'PRE_ORDER_PAYMENT_NOT_READY',
  message: 'Pre-order payment is not available until provider verification, order creation and inventory safeguards are completed.',
})

export function getAuthorPreOrderPaymentAvailability() {
  return { ...PAYMENT_DISABLED }
}
