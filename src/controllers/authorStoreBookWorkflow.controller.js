import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const STATUSES = new Set(['awaiting_reader', 'under_review', 'released', 'refunded'])

function errorResponse(res, error, action) {
  const status = ({ '22023': 400, '22P02': 400, P0002: 404, '42501': 403, '23514': 409, '40001': 409 })[error?.code] || 500
  if (status === 500) console.error(`AUTHOR STORE BOOK ${action} ERROR`, { code: error?.code, message: error?.message })
  return res.status(status).json({ ok: false, code: error?.code || 'FAILED', message: status === 500 ? `${action} failed` : error.message })
}

function owner(req, res) {
  if (String(req.admin?.role || '').toLowerCase() === 'owner') return true
  res.status(403).json({ ok: false, message: 'Owner access is required' })
  return false
}

export async function submitMyAuthorStoreBookEvidence(req, res) {
  res.set('Cache-Control', 'no-store')
  const userId = String(req.user?.user_id || '').trim()
  const holdId = String(req.params?.holdId || '').trim()
  const company = String(req.body?.delivery_company || '').trim()
  const tracking = String(req.body?.tracking_number || '').trim()
  const proof = String(req.body?.proof_url || '').trim()
  if (!UUID.test(userId) || !UUID.test(holdId)) return res.status(400).json({ ok: false, message: 'Invalid account or hold ID' })
  if (company.length < 2 || company.length > 120 || (tracking.length > 0 && tracking.length < 4) || tracking.length > 120 || proof.length < 12 || proof.length > 1024 || !/^https:\/\/[^\s<>"']+$/i.test(proof)) {
    return res.status(400).json({ ok: false, message: 'A delivery company and valid HTTPS shipping proof are required; tracking number is optional' })
  }
  try {
    const { data, error } = await supabase.rpc('submit_author_store_book_delivery_evidence', {
      p_hold_id: holdId,
      p_author_user_id: userId,
      p_delivery_company: company,
      p_tracking_number: tracking,
      p_proof_url: proof,
    })
    if (error) return errorResponse(res, error, 'DELIVERY EVIDENCE')
    if (data?.ok !== true || data?.status !== 'under_review') throw new Error('Invalid confirmation')
    return res.status(200).json({ ok: true, hold_id: data.hold_id, status: data.status })
  } catch (error) {
    console.error('AUTHOR STORE BOOK DELIVERY EVIDENCE ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to save delivery evidence' })
  }
}

export async function getMyAuthorStoreBuyerBookHoldStatuses(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const userId = String(req.user?.user_id || '').trim()
  const ids = [...new Set(String(req.query?.ids || '').split(',').filter(Boolean))]
  if (!UUID.test(userId)) return res.status(401).json({ ok: false, message: 'Unauthorized' })
  if (!ids.length || ids.length > 20 || ids.some((id) => !UUID.test(id))) {
    return res.status(400).json({ ok: false, message: 'Provide up to 20 valid order IDs' })
  }
  try {
    const { data, error } = await supabase.from('author_store_book_payment_holds')
      .select('order_id,status,release_source,reader_confirmed_at')
      .eq('buyer_id', userId).in('order_id', ids)
    if (error) throw error
    return res.status(200).json({ ok: true, holds: data || [] })
  } catch (error) {
    console.error('AUTHOR STORE BUYER BOOK HOLD STATUS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Could not load receipt status' })
  }
}

export async function getAdminAuthorStoreBookHolds(req, res) {
  res.set('Cache-Control', 'no-store')
  if (!owner(req, res)) return
  const status = String(req.query?.status || 'under_review').trim().toLowerCase()
  if (!STATUSES.has(status)) return res.status(400).json({ ok: false, message: 'Invalid status' })
  const page = Math.min(100000, Math.max(1, Math.floor(Number(req.query?.page) || 1)))
  const limit = Math.min(10, Math.max(1, Math.floor(Number(req.query?.limit) || 10)))
  const from = (page - 1) * limit
  try {
    const { data: holds, error, count } = await supabase.from('author_store_book_payment_holds')
      .select('id,order_id,author_page_id,held_amount_cents,status,delivery_company,tracking_number,proof_refs,review_requested_at,created_at', { count: 'exact' })
      .eq('status', status).order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, from + limit - 1)
    if (error) throw error
    const ids = (holds || []).map((hold) => hold.order_id)
    let orderMap = new Map()
    if (ids.length) {
      const { data, error: orderError } = await supabase.from('author_store_orders')
        .select('id,order_id,order_number,buyer_name,payment_status,order_status,status,items:author_store_order_items(product_title,product_type)')
        .in('id', ids)
      if (orderError) throw orderError
      orderMap = new Map((data || []).map((item) => [item.id, item]))
    }
    const rows = (holds || []).map((hold) => {
      const order = orderMap.get(hold.order_id)
      return {
        hold_id: hold.id,
        order_id: hold.order_id,
        order_number: order?.order_number || order?.order_id || hold.order_id,
        buyer_name: order?.buyer_name || 'Reader',
        title: (order?.items || []).filter((item) => item.product_type === 'book').map((item) => item.product_title).join(', ') || 'Physical Book',
        payment_status: order?.payment_status || '',
        order_status: order?.order_status || order?.status || '',
        status: hold.status,
        held_amount: Number(hold.held_amount_cents) / 100,
        delivery_company: hold.delivery_company,
        tracking_number: hold.tracking_number,
        proof_refs: hold.proof_refs,
        review_requested_at: hold.review_requested_at,
        created_at: hold.created_at,
      }
    })
    return res.status(200).json({ ok: true, rows, total: Number(count || 0), page, limit, has_next: from + rows.length < Number(count || 0) })
  } catch (error) {
    console.error('ADMIN AUTHOR STORE BOOK HOLDS ERROR', error)
    return res.status(500).json({ ok: false, message: 'Could not load book holds' })
  }
}
