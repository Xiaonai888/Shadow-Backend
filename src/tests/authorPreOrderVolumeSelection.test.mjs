import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAuthorPreOrderVolumeSelection } from '../services/authorPreOrderVolumeSelection.service.js'

const BOOK_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BOOK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function input(items = [{ book_id: BOOK_A, edition: 'standard', quantity: 1 }]) {
  return { items, delivery_company_key: 'jnt', signature_requested: false }
}

test('single volume normalization retains safe defaults', () => {
  const result = parseAuthorPreOrderVolumeSelection({
    ...input(),
    delivery_company_key: ' JNT ',
  })
  assert.deepEqual(result.items, [{ book_id: BOOK_A, edition: 'standard', quantity: 1 }])
  assert.equal(result.delivery_company_key, 'jnt')
  assert.equal(result.signature_requested, false)
})

test('multiple volumes are sorted, and duplicate books are rejected', () => {
  const sorted = parseAuthorPreOrderVolumeSelection(input([
    { book_id: BOOK_B, edition: 'limited', quantity: 2 },
    { book_id: BOOK_A, edition: 'standard', quantity: 1 },
  ]))
  assert.deepEqual(sorted.items.map(item => item.book_id), [BOOK_A, BOOK_B])
  assert.throws(() => parseAuthorPreOrderVolumeSelection(input([
    { book_id: BOOK_A, edition: 'standard', quantity: 1 },
    { book_id: BOOK_A.toUpperCase(), edition: 'limited', quantity: 1 },
  ])), { code: 'PRE_ORDER_VOLUME_ITEM_INVALID' })
})

test('accepts between one and ten volumes only', () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({
    book_id: `${String(i + 1).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    edition: 'standard',
    quantity: 1,
  }))
  assert.equal(parseAuthorPreOrderVolumeSelection(input(ten)).items.length, 10)
  for (const invalid of [[], [...ten, ten[0]], 'bad', null]) {
    assert.throws(() => parseAuthorPreOrderVolumeSelection(input(invalid)), {
      code: 'PRE_ORDER_VOLUME_ITEMS_INVALID',
    })
  }
})

test('edition and quantity constraints cannot be bypassed', () => {
  for (const invalid of [
    { book_id: BOOK_A, edition: 'premium', quantity: 1 },
    { book_id: BOOK_A, edition: 'standard', quantity: 0 },
    { book_id: BOOK_A, edition: 'standard', quantity: 100 },
    { book_id: BOOK_A, edition: 'standard', quantity: 1.5 },
    { book_id: BOOK_A, edition: 'standard', quantity: 'not-a-number' },
    null,
  ]) {
    assert.throws(() => parseAuthorPreOrderVolumeSelection(input([invalid])))
  }
})

test('delivery keys and signature choice are validated', () => {
  assert.throws(() => parseAuthorPreOrderVolumeSelection({
    ...input(), delivery_company_key: 'invalid key',
  }), { code: 'PRE_ORDER_VOLUME_DELIVERY_INVALID' })
  assert.throws(() => parseAuthorPreOrderVolumeSelection({
    ...input(), signature_requested: 'true',
  }), { code: 'PRE_ORDER_VOLUME_SIGNATURE_INVALID' })
  assert.equal(parseAuthorPreOrderVolumeSelection({
    ...input(), signature_requested: true,
  }).signature_requested, true)
})
