import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'

const STOCK_RPC = 'author_preorder_stock_snapshot_multivolume'
const MISSING_RPC_CODES = new Set(['PGRST202', '42883'])

function invalidStock() {
  throw preOrderError('PRE_ORDER_STOCK_SNAPSHOT_INCONSISTENT', 'Pre-order stock values are inconsistent', 503)
}

function inventoryNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean' ||
      typeof value === 'string' && !value.trim()) invalidStock()
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) invalidStock()
  return number
}

function checkedEdition(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) ||
      typeof item.enabled !== 'boolean') invalidStock()

  const quota = inventoryNumber(item.quota)
  const paidReserved = inventoryNumber(item.paid_reserved)
  const pendingHeld = inventoryNumber(item.payment_pending_held)
  const available = inventoryNumber(item.available)
  const enabled = item.enabled

  if (paidReserved + pendingHeld > quota ||
      available !== (enabled ? quota - paidReserved - pendingHeld : 0)) {
    invalidStock()
  }

  return {
    enabled,
    quota,
    paid_reserved: paidReserved,
    payment_pending_held: pendingHeld,
    available,
  }
}

export async function getAuthorPreOrderStockAvailability(campaignId) {
  const id = preOrderUuid(campaignId, 'campaign ID')
  const { data, error } = await supabase.rpc(STOCK_RPC, { p_campaign_id: id })
  if (error) {
    console.error('PRE_ORDER_STOCK_SNAPSHOT_FAILED:', String(error.code || 'unknown'))
    if (MISSING_RPC_CODES.has(String(error.code || ''))) {
      throw preOrderError('PRE_ORDER_STOCK_SNAPSHOT_MIGRATION_REQUIRED', 'Multi-volume stock snapshot has not been installed', 503)
    }
    throw preOrderError('PRE_ORDER_STOCK_SNAPSHOT_UNAVAILABLE', 'Stock information is temporarily unavailable', 503)
  }
  if (!Array.isArray(data) || data.length > 10) {
    throw preOrderError('PRE_ORDER_STOCK_SNAPSHOT_INVALID', 'Stock response was invalid', 503)
  }

  const seen = new Set()
  return data.map(book => {
    const bookId = preOrderUuid(book?.book_id, 'book ID').toLowerCase()
    if (seen.has(bookId)) invalidStock()
    seen.add(bookId)
    return {
      book_id: bookId,
      title: String(book?.title || ''),
      standard: checkedEdition(book?.standard),
      limited: checkedEdition(book?.limited),
      snapshot_only: true,
    }
  })
}
