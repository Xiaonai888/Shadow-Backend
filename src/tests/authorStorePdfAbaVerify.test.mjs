import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyAuthorStorePdfAbaPayment } from '../services/authorStorePdfAbaVerify.service.js'

const env = {
  ABA_PAYWAY_MERCHANT_ID: 'sandbox-merchant',
  ABA_PAYWAY_API_KEY: 'sandbox-secret',
  ABA_PAYWAY_MODE: 'sandbox',
}
const order = { order_id: 'AMWQMAM75A7BD6EAC', total_usd: 1.25, currency: 'USD' }
const confirmed = {
  status: { code: '0', tran_id: order.order_id },
  data: { payment_status: 'APPROVED', payment_status_code: 0, original_amount: '1.25', original_currency: 'USD' },
}
const asFetch = (payload, status = 200) => async () => ({ ok: status === 200, status, json: async () => payload })

test('provider-confirmed exact USD payment verifies the correct transaction', async () => {
  const verified = await verifyAuthorStorePdfAbaPayment(order, { env, fetchImpl: asFetch(confirmed) })
  assert.equal(verified.verified, true)
  assert.equal(verified.transaction_id, order.order_id)
})

test('a pending payment does not unlock access', async () => {
  const pending = { ...confirmed, data: { ...confirmed.data, payment_status: 'PENDING' } }
  const verified = await verifyAuthorStorePdfAbaPayment(order, { env, fetchImpl: asFetch(pending) })
  assert.equal(verified.verified, false)
})

test('mismatched payment, currency or transaction is blocked', async () => {
  const cases = [
    { ...confirmed, data: { ...confirmed.data, original_amount: '2.25' } },
    { ...confirmed, data: { ...confirmed.data, original_currency: 'KHR' } },
    { ...confirmed, status: { ...confirmed.status, tran_id: 'WRONGTRANSACTION' } },
  ]
  for (const data of cases) {
    await assert.rejects(verifyAuthorStorePdfAbaPayment(order, { env, fetchImpl: asFetch(data) }), { code: 'ABA_PDF_VERIFY_MISMATCH' })
  }
})

test('provider HTTP error cannot unlock a PDF', async () => {
  await assert.rejects(verifyAuthorStorePdfAbaPayment(order, { env, fetchImpl: asFetch(confirmed, 502) }), { code: 'ABA_PDF_VERIFY_HTTP' })
})

test('missing merchant credentials are rejected before making a network request', async () => {
  await assert.rejects(verifyAuthorStorePdfAbaPayment(order, { env: {}, fetchImpl: () => { throw new Error('Unexpected fetch') } }), { code: 'ABA_PDF_VERIFY_CONFIG' })
})
