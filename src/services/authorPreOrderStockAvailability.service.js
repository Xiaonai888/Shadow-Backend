import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'

export async function getAuthorPreOrderStockAvailability(campaignId) {
  const id = preOrderUuid(campaignId, 'campaign ID')
  const { data, error } = await supabase.rpc('author_preorder_stock_snapshot', {
    p_campaign_id: id,
  })
  if (error) {
    console.error('PRE_ORDER_STOCK_SNAPSHOT_FAILED:', String(error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_STOCK_SNAPSHOT_UNAVAILABLE', 'Stock information is temporarily unavailable', 503)
  }
  if (!Array.isArray(data)) {
    throw preOrderError('PRE_ORDER_STOCK_SNAPSHOT_INVALID', 'Stock response was invalid', 503)
  }

  return data.map(book => {
    const edition = kind => {
      const item = book?.[kind]
      const quota = Number(item?.quota)
      const paidReserved = Number(item?.paid_reserved)
      const pendingHeld = Number(item?.payment_pending_held)
      const available = Number(item?.available)
      if (![quota, paidReserved, pendingHeld, available].every(Number.isSafeInteger) ||
          quota < 0 || paidReserved < 0 || pendingHeld < 0 || available < 0 ||
          paidReserved + pendingHeld > quota ||
          available !== (item?.enabled === true ? quota - paidReserved - pendingHeld : 0)) {
        throw preOrderError('PRE_ORDER_STOCK_SNAPSHOT_INCONSISTENT', 'Pre-order stock values are inconsistent', 503)
      }
      return {
        enabled: item.enabled === true,
        quota,
        paid_reserved: paidReserved,
        payment_pending_held: pendingHeld,
        available,
      }
    }
    return {
      book_id: preOrderUuid(book?.book_id, 'book ID'),
      title: String(book?.title || ''),
      standard: edition('standard'),
      limited: edition('limited'),
      snapshot_only: true,
    }
  })
}
