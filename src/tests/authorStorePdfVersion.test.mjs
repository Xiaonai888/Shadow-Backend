import test from 'node:test'
import assert from 'node:assert/strict'
import { enrichPurchasedPdfVersions, mergePurchasedPdfVersion, normalizePdfUpdateNote, normalizePdfVersion, setPurchasedPdfVersionHeader } from '../services/authorStorePdfVersion.service.js'

const purchase = { id: 'grant', buyer_id: 'buyer', order_id: 'paid-order', product_id: 'pdf', pdf_file_url: 'https://example.com/old.pdf', pdf_file_name: 'old.pdf', access_rule: 'Read online only' }
const product = { id: 'pdf', product_type: 'pdf', pdf_is_private: true, pdf_file_url: '', pdf_file_name: 'new.pdf', access_rule: 'Read online only', pdf_version: 2, pdf_updated_at: '2026-11-26T00:00:00Z', pdf_update_note: 'Corrected text' }

test('private replacement never exposes an old public URL and preserves the paid grant', () => {
  const result = mergePurchasedPdfVersion(purchase, product)
  assert.equal(result.pdf_file_url, '')
  assert.equal(result.pdf_is_private, true)
  assert.equal(result.pdf_file_name, 'new.pdf')
  assert.equal(result.pdf_version, 2)
  assert.equal(result.pdf_update_note, 'Corrected text')
  for (const field of ['id', 'buyer_id', 'order_id', 'product_id']) assert.equal(result[field], purchase[field])
  assert.equal(purchase.pdf_file_name, 'old.pdf')
})

test('current public PDF replaces a stale purchased URL', () => {
  const result = mergePurchasedPdfVersion(purchase, { ...product, pdf_is_private: false, pdf_file_url: 'https://example.com/new.pdf' })
  assert.equal(result.pdf_file_url, 'https://example.com/new.pdf')
  assert.equal(result.pdf_version, 2)
})

test('a missing product keeps historical metadata without claiming a current version', () => {
  const result = mergePurchasedPdfVersion(purchase, null)
  assert.equal(result.pdf_file_url, purchase.pdf_file_url)
  assert.equal(result.pdf_version, 0)
})

test('batch lookup deduplicates IDs, preserves order and does not expose private storage keys', async () => {
  const calls = []
  const db = { from(table) { assert.equal(table, 'author_store_products'); return { select(fields) { assert.ok(!fields.includes('pdf_storage_key')); return { async in(field, ids) { assert.equal(field, 'id'); calls.push(ids); return { data: [product].filter(row => ids.includes(row.id)) } } } } } } }
  const result = await enrichPurchasedPdfVersions(db, [purchase, { ...purchase, id: 'second' }, { ...purchase, product_id: 'other' }])
  assert.deepEqual(calls, [['pdf', 'other']])
  assert.deepEqual(result.map(row => row.pdf_version), [2, 2, 0])
  assert.equal(result[1].id, 'second')
  assert.ok(!('pdf_storage_key' in result[0]))
  const many = Array.from({ length: 201 }, (_, index) => ({ product_id: `id-${index}` }))
  await enrichPurchasedPdfVersions(db, many)
  assert.deepEqual(calls.slice(1).map(ids => ids.length), [100, 100, 1])
})

test('database errors are not silently treated as successful version checks', async () => {
  const error = new Error('database unavailable')
  const db = { from() { return { select() { return { async in() { return { error } } } } } } }
  await assert.rejects(enrichPurchasedPdfVersions(db, [purchase]), error)
})

test('version and update note normalization and cross-origin response header', () => {
  assert.equal(normalizePdfVersion(-1), 0)
  assert.equal(normalizePdfVersion(1.5), 0)
  assert.equal(normalizePdfUpdateNote('  fixed  '), 'fixed')
  assert.equal(Array.from(normalizePdfUpdateNote('😀'.repeat(501))).length, 500)
  const headers = []
  const res = { set(...args) { headers.push(args) }, append(...args) { headers.push(args) } }
  setPurchasedPdfVersionHeader(res, 3)
  assert.deepEqual(headers, [['X-Shadow-Pdf-Version', '3'], ['Access-Control-Expose-Headers', 'X-Shadow-Pdf-Version']])
})
