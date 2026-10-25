import { createHash } from 'node:crypto'
import { supabase } from '../config/supabase.js'
import { getVerifiedBinanceReceiver } from './binanceReceiverGuard.service.js'

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const REASON_MIN = 12
const REASON_MAX = 500

export class BinanceAdminDecisionError extends Error {
  constructor(code, status = 400) {
    super(code)
    this.name = 'BinanceAdminDecisionError'
    this.code = code
    this.status = status
  }
}

function requireOrderId(orderId) {
  const id = String(orderId || '').trim()
  if (!UUID_RE.test(id)) throw new BinanceAdminDecisionError('INVALID_ORDER_ID')
  return id
}

function requireReason(reason) {
  const value = typeof reason === 'string' ? reason.trim() : ''
  if (value.length < REASON_MIN || value.length > REASON_MAX) {
    throw new BinanceAdminDecisionError('INVALID_REASON')
  }
  return value
}

async function requireVerifiedReceiver(orderId) {
  const { data: order, error } = await supabase
    .from('binance_checkout_orders')
    .select('id,receiver_uid,receiver_name,receiver_qr_sha256,status')
    .eq('id', orderId)
    .maybeSingle()
  if (error) throw error
  if (!order) throw new BinanceAdminDecisionError('ORDER_NOT_FOUND', 404)
  if (order.status === 'credited') return
  if (order.status !== 'pending_review') throw new BinanceAdminDecisionError('NOT_PENDING_REVIEW', 409)
  const receiver = await getVerifiedBinanceReceiver()
  const currentHash = createHash('sha256').update(receiver.qrBytes).digest('hex')
  if (order.receiver_uid !== receiver.uid || order.receiver_name !== receiver.name || order.receiver_qr_sha256 !== currentHash) {
    throw new BinanceAdminDecisionError('RECEIVER_CHANGED', 409)
  }
}

function mapDatabaseError(error) {
  if (error?.code === '23505') throw new BinanceAdminDecisionError('ALREADY_DECIDED', 409)
  const message = String(error?.message || '')
  const codes = {
    BINANCE_CHECKOUT_NOT_FOUND: [404, 'ORDER_NOT_FOUND'],
    BINANCE_CLAIM_NOT_FOUND: [404, 'CLAIM_NOT_FOUND'],
    BINANCE_CHECKOUT_NOT_PENDING_REVIEW: [409, 'NOT_PENDING_REVIEW'],
    BINANCE_CHECKOUT_ALREADY_CREDITED: [409, 'ALREADY_CREDITED'],
    BINANCE_CREDIT_AUDIT_MISSING: [409, 'CREDIT_AUDIT_MISSING'],
    BINANCE_OFFICIAL_RECEIPT_NOT_FOUND: [409, 'RECEIPT_NOT_FOUND'],
    BINANCE_RECEIPT_AMOUNT_MISMATCH: [409, 'AMOUNT_MISMATCH'],
    BINANCE_RECEIPT_TIME_MISMATCH: [409, 'TIME_MISMATCH'],
    BINANCE_CREDIT_CONFIRMATION_MISMATCH: [409, 'CREDIT_MISMATCH'],
    BINANCE_MANUAL_CONFIRMATIONS_REQUIRED: [400, 'CONFIRMATION_REQUIRED'],
    INVALID_BINANCE_ADMIN_DECISION: [400, 'INVALID_DECISION'],
  }
  for (const [marker, [status, code]] of Object.entries(codes)) {
    if (message.includes(marker)) throw new BinanceAdminDecisionError(code, status)
  }
  if (message.toLowerCase().includes('already credited') || message.toLowerCase().includes('already used')) {
    throw new BinanceAdminDecisionError('TRANSACTION_ALREADY_USED', 409)
  }
  if (['PGRST202', '42883', '42P01'].includes(String(error?.code))) {
    throw new BinanceAdminDecisionError('DATABASE_NOT_READY', 503)
  }
  throw error
}

export async function approveBinanceCheckoutReview({ orderId, adminId, adminEmail, reason }) {
  const id = requireOrderId(orderId)
  const note = requireReason(reason)
  await requireVerifiedReceiver(id)
  const { data, error } = await supabase.rpc('approve_binance_checkout_admin_decision_v1', {
    p_order_id: id,
    p_admin_id: adminId,
    p_admin_email: adminEmail,
    p_reason: note,
    p_official_receipt_verified: true,
    p_reader_verified: true,
    p_receiver_verified: true,
  })
  if (error) mapDatabaseError(error)
  if (data?.ok !== true || data?.order_id !== id || data?.status !== 'credited') {
    throw new Error('Unexpected approval result')
  }
  return data
}

export async function rejectBinanceCheckoutReview({ orderId, adminId, adminEmail, reason }) {
  const id = requireOrderId(orderId)
  const note = requireReason(reason)
  const { data, error } = await supabase.rpc('reject_binance_checkout_admin_decision_v1', {
    p_order_id: id,
    p_admin_id: adminId,
    p_admin_email: adminEmail,
    p_reason: note,
  })
  if (error) mapDatabaseError(error)
  if (data?.ok !== true || data?.order_id !== id || data?.status !== 'rejected' || data?.credit_applied !== false) {
    throw new Error('Unexpected rejection result')
  }
  return data
}
