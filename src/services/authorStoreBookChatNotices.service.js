import { supabase } from '../config/supabase.js'
import { getBookChatOrders } from './authorStoreBookChat.service.js'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const PAGE_SIZE = 10
const ALLOWED_TYPES = new Set(['payment_verified', 'book_shipped', 'reader_received', 'owner_released', 'refunded'])

export class BookNoticeError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function validId(value) {
  const id = String(value || '').trim()
  if (!UUID.test(id)) throw new BookNoticeError(400, 'Invalid identifier')
  return id
}

async function accessibleOrderIds(userId, conversationId) {
  const data = await getBookChatOrders(userId, conversationId)
  return {
    role: data.role,
    ids: data.orders.filter((order) => order.paymentVerified && order.isPhysicalBook).map((order) => order.id),
  }
}

export async function listBookChatNotices(userId, conversationId, page = 1) {
  const uid = validId(userId)
  const cid = validId(conversationId)
  const currentPage = Number(page)
  if (!Number.isSafeInteger(currentPage) || currentPage < 1 || currentPage > 1000) {
    throw new BookNoticeError(400, 'Invalid notice page')
  }
  const access = await accessibleOrderIds(uid, cid)
  if (!access.ids.length) {
    return { notices: [], total: 0, has_next: false, page: currentPage, limit: PAGE_SIZE, role: access.role }
  }
  const from = (currentPage - 1) * PAGE_SIZE
  const { data, count, error } = await supabase
    .from('author_store_book_chat_notices')
    .select('id,order_id,notice_type,seen_at,created_at', { count: 'exact' })
    .eq('recipient_user_id', uid)
    .in('order_id', access.ids)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + PAGE_SIZE - 1)
  if (error) throw error
  const notices = (data || []).filter((notice) => ALLOWED_TYPES.has(notice.notice_type))
  return {
    notices,
    total: Number(count || 0),
    has_next: from + (data || []).length < Number(count || 0),
    page: currentPage,
    limit: PAGE_SIZE,
    role: access.role,
  }
}

export async function markBookChatNoticeSeen(userId, conversationId, noticeId) {
  const uid = validId(userId)
  const cid = validId(conversationId)
  const nid = validId(noticeId)
  const { data: notice, error: readError } = await supabase
    .from('author_store_book_chat_notices')
    .select('id,order_id,notice_type,seen_at')
    .eq('id', nid)
    .eq('recipient_user_id', uid)
    .maybeSingle()
  if (readError) throw readError
  if (!notice) throw new BookNoticeError(404, 'Book notification not found')
  const access = await accessibleOrderIds(uid, cid)
  if (!access.ids.includes(notice.order_id)) {
    throw new BookNoticeError(403, 'Book notification access denied')
  }
  if (!ALLOWED_TYPES.has(notice.notice_type)) {
    throw new BookNoticeError(409, 'Unsupported notification')
  }
  if (notice.seen_at) return { id: nid, seen_at: notice.seen_at }
  const { data: saved, error: saveError } = await supabase
    .from('author_store_book_chat_notices')
    .update({ seen_at: new Date().toISOString() })
    .eq('id', nid)
    .eq('recipient_user_id', uid)
    .is('seen_at', null)
    .select('id,seen_at')
    .maybeSingle()
  if (saveError) throw saveError
  if (saved) return { id: saved.id, seen_at: saved.seen_at }
  const { data: updated, error: retryError } = await supabase
    .from('author_store_book_chat_notices')
    .select('id,seen_at')
    .eq('id', nid)
    .eq('recipient_user_id', uid)
    .maybeSingle()
  if (retryError) throw retryError
  if (!updated?.seen_at) throw new BookNoticeError(409, 'Notice status changed; retry')
  return { id: updated.id, seen_at: updated.seen_at }
}
