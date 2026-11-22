import test from 'node:test'
import assert from 'node:assert/strict'
import {
  preOrderPaymentId,
  preOrderPaymentTransaction,
  createPreOrderPaymentTransaction,
  preOrderPaymentCents,
  preOrderPaymentCurrency,
  preOrderProviderPaidAt,
} from '../src/services/authorPreOrderPaymentValidation.service.js'

test('payment amounts use integer cents, not floating point arithmetic', () => {
  for (const [amount, cents] of [
    ['0', 0], ['0.01', 1], ['1.10', 110], ['29.99', 2999],
    ['9999999999.99', 999999999999],
  ]) {
    assert.equal(preOrderPaymentCents(amount), cents)
  }
})

test('forged, negative, exponent and overprecision amounts are rejected', () => {
  for (const value of ['-1.00', '01.00', '1e3', '1.001', '1,000', 'Infinity', '', ' 1 0 ', '10000000000']) {
    assert.throws(() => preOrderPaymentCents(value), { code: 'PRE_ORDER_PAYMENT_AMOUNT_INVALID' })
  }
})

test('payment IDs are lowercase UUIDs and transaction IDs are strictly formatted', () => {
  assert.equal(preOrderPaymentId('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  assert.throws(() => preOrderPaymentId('wrong-id'), { code: 'PRE_ORDER_PAYMENT_INVALID_ID' })
  assert.equal(preOrderPaymentTransaction('P123456789012'), 'P123456789012')
  for (const invalid of ['p123456789012', 'P123', 'P123456789012-XX', '']) {
    assert.throws(() => preOrderPaymentTransaction(invalid), { code: 'PRE_ORDER_PAYMENT_INVALID_TRANSACTION' })
  }
})

test('generated transaction references are valid and not reused', () => {
  const keys = Array.from({ length: 100 }, () => createPreOrderPaymentTransaction())
  assert.equal(new Set(keys).size, 100)
  for (const key of keys) assert.equal(preOrderPaymentTransaction(key), key)
})

test('USD only and provider timestamps are bounded', () => {
  assert.equal(preOrderPaymentCurrency('USD'), 'USD')
  for (const currency of ['KHR', 'usd', null]) {
    assert.throws(() => preOrderPaymentCurrency(currency), { code: 'PRE_ORDER_PAYMENT_CURRENCY_INVALID' })
  }
  assert.equal(preOrderProviderPaidAt('2020-01-01T00:00:00Z'), '2020-01-01T00:00:00.000Z')
  assert.equal(preOrderProviderPaidAt('bad'), null)
  assert.equal(preOrderProviderPaidAt(new Date(Date.now() + 11 * 60_000).toISOString()), null)
})
