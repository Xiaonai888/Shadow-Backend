import { randomUUID } from 'node:crypto'
import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'

const KINDS = new Set(['reconciliation', 'finalization', 'expiry', 'review'])
const OUTCOMES = new Set(['pending', 'verified', 'finalized', 'released', 'manual_review', 'failed', 'skipped'])
const CODE = /^PRE_ORDER_[A-Z0-9_]{3,80}$/
const KEY = /^[a-z0-9:_-]{8,120}$/

export function createPreOrderReconciliationEventKey() {
  return `recon:${randomUUID().replace(/-/g, '')}`
}

export async function recordPreOrderReconciliationEvent({ orderId, eventKey, kind, outcome, reasonCode }) {
  const id = preOrderUuid(orderId, 'order ID')
  const key = eventKey === undefined ? createPreOrderReconciliationEventKey() : String(eventKey)
  const reason = String(reasonCode || '')
  if (!KEY.test(key) || !KINDS.has(kind) || !OUTCOMES.has(outcome) || !CODE.test(reason)) {
    throw preOrderError('PRE_ORDER_RECONCILIATION_AUDIT_INPUT_INVALID', 'Invalid payment audit event', 400)
  }
  const { data, error } = await supabase.rpc('author_preorder_record_reconciliation_event', {
    p_order_id: id,
    p_event_key: key,
    p_event_kind: kind,
    p_outcome: outcome,
    p_reason_code: reason,
  })
  if (error) {
    console.error('PRE_ORDER_RECONCILIATION_AUDIT_STORAGE:', String(error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_RECONCILIATION_AUDIT_UNAVAILABLE', 'Payment audit record was not stored', 503)
  }
  if (!data || data.order_id !== id || typeof data.event_id !== 'string' || typeof data.inserted !== 'boolean') {
    throw preOrderError('PRE_ORDER_RECONCILIATION_AUDIT_RESPONSE_INVALID', 'Payment audit record was not confirmed', 503)
  }
  return { event_id: data.event_id, inserted: data.inserted, created_at: data.created_at }
}
