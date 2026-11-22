import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'

export async function classifyAuthorPreOrderReconciliationHold(orderId) {
  const id = preOrderUuid(orderId, 'order ID').toLowerCase()
  const [volumeResult, legacyResult] = await Promise.all([
    supabase.from('author_preorder_volume_holds')
      .select('book_id,edition,status')
      .eq('order_id', id).limit(11),
    supabase.from('author_preorder_stock_holds')
      .select('status').eq('order_id', id).limit(2),
  ])
  if (volumeResult.error || legacyResult.error) {
    console.error('PRE_ORDER_RECON_HOLD_CLASSIFY_DB:',
      String(volumeResult.error?.code || legacyResult.error?.code || 'unknown'))
    throw preOrderError('PRE_ORDER_RECON_HOLD_CLASSIFY_UNAVAILABLE', 'Could not identify payment stock holds', 503)
  }
  const volumes = volumeResult.data
  const legacy = legacyResult.data
  if (!Array.isArray(volumes) || !Array.isArray(legacy) ||
      volumes.length > 10 || legacy.length > 1 ||
      (volumes.length > 0 && legacy.length > 0)) {
    throw preOrderError('PRE_ORDER_RECON_HOLD_CONFLICT', 'Conflicting stock hold formats require review', 409)
  }
  if (volumes.length > 0) {
    const ids = new Set(volumes.map(row => String(row?.book_id || '').toLowerCase()))
    if (ids.size !== volumes.length || ids.has('') ||
        volumes.some(row => !['held', 'consumed', 'released'].includes(row?.status) ||
          !['standard', 'limited'].includes(row?.edition))) {
      throw preOrderError('PRE_ORDER_RECON_VOLUME_HOLDS_INVALID', 'Multi-volume stock holds require review', 409)
    }
    return { order_id: id, hold_type: 'multi_volume', item_count: volumes.length }
  }
  if (legacy.length === 1) {
    if (!['held', 'consumed', 'released'].includes(legacy[0]?.status)) {
      throw preOrderError('PRE_ORDER_RECON_LEGACY_HOLD_INVALID', 'Legacy stock hold requires review', 409)
    }
    return { order_id: id, hold_type: 'legacy', item_count: 1 }
  }
  return { order_id: id, hold_type: 'missing', item_count: 0 }
}
