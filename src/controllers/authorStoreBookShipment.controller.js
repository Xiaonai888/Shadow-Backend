import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const ERROR_STATUS = { '22023': 400, '22P02': 400, P0002: 404, '42501': 403, '23514': 409, '40001': 409 }

export async function markMyAuthorStoreBookShipped(req, res) {
  res.set('Cache-Control', 'private, no-store')
  res.set('Vary', 'Authorization')

  const authorId = String(req.user?.user_id || '').trim()
  const holdId = String(req.params?.holdId || '').trim()
  const proofId = String(req.body?.proof_id || '').trim()
  const company = String(req.body?.delivery_company || '').trim()
  const tracking = String(req.body?.tracking_number || '').trim()

  if (![authorId, holdId, proofId].every((id) => UUID.test(id))) {
    return res.status(400).json({ ok: false, message: 'Invalid book hold or shipping proof' })
  }
  if (company.length < 2 || company.length > 120 || (tracking && tracking.length < 4) || tracking.length > 120) {
    return res.status(400).json({ ok: false, message: 'Delivery company is required; tracking number is optional' })
  }

  try {
    const { data, error } = await supabase.rpc('finalize_author_store_book_shipment', {
      p_hold_id: holdId,
      p_author_user_id: authorId,
      p_delivery_company: company,
      p_tracking_number: tracking,
      p_proof_id: proofId,
    })
    if (error) {
      const status = ERROR_STATUS[error.code] || 500
      if (status === 500) console.error('BOOK SHIPMENT FINALIZE ERROR', { code: error.code, message: error.message })
      return res.status(status).json({ ok: false, code: error.code, message: status === 500 ? 'Unable to save shipment' : error.message })
    }
    if (!data || data.ok !== true || data.status !== 'under_review' || data.hold_id !== holdId) {
      throw new Error('Invalid shipment confirmation response')
    }
    return res.status(200).json({ ok: true, already_shipped: data.already_shipped === true, hold_id: data.hold_id, order_id: data.order_id, status: data.status })
  } catch (error) {
    console.error('BOOK SHIPMENT SAVE ERROR', error)
    return res.status(500).json({ ok: false, message: 'Unable to verify shipping submission' })
  }
}
