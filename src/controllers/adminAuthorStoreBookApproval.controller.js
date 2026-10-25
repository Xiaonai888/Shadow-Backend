import { supabase } from '../config/supabase.js'
import { verifyAdminPasskeyPin } from '../services/adminPasskeyPin.service.js'

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

export async function approveAdminAuthorStoreBookHold(req, res) {
  res.set('Cache-Control', 'no-store')

  if (String(req.admin?.role || '').toLowerCase() !== 'owner') {
    return res.status(403).json({ ok: false, message: 'Owner access is required' })
  }

  const orderId = String(req.params?.orderId || '').trim()
  const reason = String(req.body?.review_reason || '').trim()
  const pin = String(req.body?.passkey_pin || '').trim()
  const adminId = String(req.admin?.admin_id || req.admin?.id || req.admin?.email || '').trim()

  if (!UUID_PATTERN.test(orderId)) {
    return res.status(400).json({ ok: false, message: 'Invalid order ID' })
  }
  if (Array.from(reason).length < 15 || Array.from(reason).length > 2000) {
    return res.status(400).json({ ok: false, message: 'Review reason must contain 15–2000 characters' })
  }
  if (!adminId || Array.from(adminId).length > 120) {
    return res.status(403).json({ ok: false, message: 'Verified admin identity is required' })
  }
  if (!/^\d{6}$/.test(pin)) {
    return res.status(400).json({ ok: false, message: 'Enter your six-digit Owner Passkey' })
  }

  try {
    const verified = await verifyAdminPasskeyPin({
      admin: req.admin,
      req,
      pin,
      purpose: `author_store_book_approval:${orderId}`,
    })

    if (!verified.ok) {
      return res.status(typeof verified.status === 'number' ? verified.status : 403).json({
        ok: false,
        code: verified.code || 'PASSKEY_VERIFICATION_FAILED',
        message: verified.message || 'Owner Passkey verification failed',
        attempts_left: verified.attempts_left,
        locked_until: verified.locked_until,
        retry_after_seconds: verified.retry_after_seconds,
      })
    }

    const { data, error } = await supabase.rpc('approve_author_store_book_hold', {
      p_order_id: orderId,
      p_admin_id: adminId,
      p_review_reason: reason,
    })

    if (error) {
      const statusByCode = {
        '22023': 400,
        '22P02': 400,
        P0002: 404,
        '42501': 403,
        '23514': 409,
        '40001': 409,
      }
      const status = statusByCode[error.code] || 500
      if (status === 500) {
        console.error('AUTHOR STORE BOOK APPROVAL ERROR:', {
          code: error.code,
          message: error.message,
        })
      }
      return res.status(status).json({
        ok: false,
        code: status === 409 ? 'BOOK_HOLD_NOT_ELIGIBLE' : status === 404 ? 'BOOK_HOLD_NOT_FOUND' : 'BOOK_APPROVAL_FAILED',
        message: status === 409
          ? 'The book must be paid, shipped, under review and have delivery evidence'
          : status === 404
            ? 'Order or book payment hold not found'
            : status === 400
              ? 'Invalid approval details'
              : status === 403
                ? 'Book hold ownership could not be verified'
                : 'Unable to approve book payment',
      })
    }

    if (!data || data.ok !== true || data.status !== 'released') {
      console.error('AUTHOR STORE BOOK APPROVAL INVALID RESULT')
      return res.status(500).json({ ok: false, message: 'Unable to verify book payment approval' })
    }

    return res.status(200).json({
      ok: true,
      order_id: data.order_id,
      hold_id: data.hold_id,
      status: 'released',
      already_approved: data.already_approved === true,
      released_at: data.released_at,
    })
  } catch (error) {
    console.error('AUTHOR STORE BOOK APPROVAL FAILED:', error)
    return res.status(500).json({ ok: false, message: 'Unable to approve book payment' })
  }
}
