import { supabase } from '../config/supabase.js'
import { preOrderError } from './authorPreOrderValidation.service.js'

function checkedCount(result, type) {
  if (result?.error) {
    console.error(`PRE_ORDER_RECON_OPS_${type}_COUNT_DB:`, String(result.error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_RECON_OPS_HEALTH_UNAVAILABLE', 'Pending payment hold counts could not be checked', 503)
  }
  if (!Number.isSafeInteger(result?.count) || result.count < 0) {
    throw preOrderError('PRE_ORDER_RECON_OPS_HEALTH_INVALID', 'Pending payment hold count is invalid', 503)
  }
  return result.count
}

export async function inspectAuthorPreOrderReconciliationOpsHealth({ now = new Date() } = {}) {
  const timestamp = now instanceof Date ? now.getTime() : Date.parse(String(now || ''))
  if (!Number.isFinite(timestamp)) {
    throw preOrderError('PRE_ORDER_RECON_OPS_TIME_INVALID', 'Reconciliation health timestamp is invalid', 400)
  }
  const expiresAt = new Date(timestamp).toISOString()
  const [legacy, volume] = await Promise.all([
    supabase.from('author_preorder_stock_holds')
      .select('order_id', { head: true, count: 'exact' })
      .eq('status', 'held')
      .lte('expires_at', expiresAt),
    supabase.from('author_preorder_volume_holds')
      .select('order_id', { head: true, count: 'exact' })
      .eq('status', 'held')
      .lte('expires_at', expiresAt),
  ])
  const legacyRows = checkedCount(legacy, 'LEGACY')
  const volumeRows = checkedCount(volume, 'VOLUME')
  return {
    inspected_at: expiresAt,
    legacy_expired_held_rows: legacyRows,
    volume_expired_held_rows: volumeRows,
    total_expired_held_rows: legacyRows + volumeRows,
    count_unit: 'stock_hold_rows_not_distinct_orders',
    needs_attention: legacyRows + volumeRows > 0,
    no_automatic_release: true,
  }
}
