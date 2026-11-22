import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sql = readFileSync(new URL('../../sql/20261122_author_preorder_cross_format_stock_guard_v18.sql', import.meta.url), 'utf8')

test('stock guard is installed on both legacy and multi-volume hold tables', () => {
  for (const table of ['author_preorder_stock_holds', 'author_preorder_volume_holds']) {
    assert.match(sql, new RegExp(`before insert or update of book_id, edition, quantity, status\\s+on public\\.${table}`, 'i'))
  }
  assert.equal((sql.match(/create trigger author_preorder_/gi) || []).length, 2)
})

test('guard locks the book before reading held inventory', () => {
  const lock = sql.indexOf('from public.author_preorder_books')
  const legacy = sql.indexOf('from public.author_preorder_stock_holds')
  const multi = sql.indexOf('from public.author_preorder_volume_holds')
  assert.ok(lock >= 0 && lock < legacy && legacy < multi)
  assert.match(sql.slice(lock, legacy), /for update\s*;/i)
})

test('stock guard counts both hold types and paid reservations', () => {
  assert.match(sql, /v_reserved\s*\+\s*v_legacy_held\s*\+\s*v_multi_held\s*\+\s*new\.quantity::bigint\s*>\s*v_quota/i)
  assert.match(sql, /raise exception 'PRE_ORDER_CROSS_FORMAT_STOCK_EXCEEDED'/)
  assert.match(sql, /v_book\.standard_reserved/)
  assert.match(sql, /v_book\.limited_reserved/)
})

test('stock guard does not double-count the row being updated', () => {
  assert.match(sql, /tg_table_name <> 'author_preorder_stock_holds' or h\.order_id <> new\.order_id/i)
  assert.match(sql, /tg_table_name <> 'author_preorder_volume_holds'[\s\S]*?h\.order_id <> new\.order_id/i)
})

test('guard checks enabled edition, valid quantity and held status', () => {
  assert.match(sql, /new\.status is distinct from 'held'/i)
  assert.match(sql, /new\.quantity not between 1 and 99/i)
  assert.match(sql, /v_enabled is distinct from true/i)
})

test('migration is schema-only and does not change existing stock or enable payment', () => {
  assert.doesNotMatch(sql, /\b(?:update|delete from|truncate|insert into)\s+public\.author_preorder_(?:orders|books|stock_holds|volume_holds)\b/i)
  assert.doesNotMatch(sql, /author_preorder_payment_availability|payment_enabled\s*=\s*true/i)
  assert.match(sql, /revoke all on function public\.author_preorder_cross_format_stock_guard/i)
})
