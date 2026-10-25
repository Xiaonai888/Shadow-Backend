import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

export class BookChatError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function requireId(value) {
  const id = String(value || '').trim()
  if (!UUID.test(id)) throw new BookChatError(400, 'Invalid identifier')
  return id
}

function failIf(error) {
  if (error) throw error
}

export async function linkPaidBookOrderToChat(orderId) {
  const { data, error } = await supabase.rpc('link_author_store_paid_book_to_chat', {
    p_order_id: requireId(orderId),
  })
  failIf(error)
  if (!data || data.ok !== true) throw new Error('Could not link paid book order')
  return data
}

async function getRole(userId, conversationId) {
  const { data: participant, error: participantError } = await supabase
    .from('chat_participants')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle()
  failIf(participantError)
  if (!participant) throw new BookChatError(403, 'Chat access denied')

  const { data: conversation, error: conversationError } = await supabase
    .from('chat_conversations')
    .select('conversation_type, author_page_id, request_status')
    .eq('id', conversationId)
    .maybeSingle()
  failIf(conversationError)
  if (!conversation || conversation.conversation_type !== 'reader_author' ||
      ['declined', 'blocked'].includes(conversation.request_status)) {
    throw new BookChatError(403, 'Book order chat unavailable')
  }

  const { data: author, error: authorError } = await supabase
    .from('author_pages')
    .select('user_id')
    .eq('id', conversation.author_page_id)
    .maybeSingle()
  failIf(authorError)
  if (!author) throw new BookChatError(404, 'Author page not found')
  return { authorPageId: conversation.author_page_id, role: author.user_id === userId ? 'author' : 'reader' }
}

export async function getBookChatOrders(userId, conversationId) {
  const uid = requireId(userId)
  const cid = requireId(conversationId)
  const access = await getRole(uid, cid)
  const { data: links, error: linksError } = await supabase
    .from('author_store_book_chat_links')
    .select('order_id,hold_id,reader_popup_seen_at,author_popup_seen_at,created_at')
    .eq('conversation_id', cid)
    .order('created_at', { ascending: false })
    .limit(10)
  failIf(linksError)
  if (!links?.length) return { role: access.role, orders: [] }

  const ids = links.map((link) => link.order_id)
  const { data: orders, error: ordersError } = await supabase
    .from('author_store_orders')
    .select('id,order_number,order_id,buyer_id,author_page_id,payment_status,paid_at,created_at,order_status,status,items:author_store_order_items(product_type,product_title)')
    .in('id', ids)
  failIf(ordersError)
  const { data: holds, error: holdsError } = await supabase
    .from('author_store_book_payment_holds')
    .select('id,order_id,held_amount_cents,status,reader_confirmed_at,released_at,release_source,delivery_company,tracking_number,proof_refs')
    .in('order_id', ids)
  failIf(holdsError)

  const orderById = new Map((orders || []).map((order) => [String(order.id), order]))
  const holdById = new Map((holds || []).map((hold) => [String(hold.order_id), hold]))
  const output = []

  for (const link of links) {
    const order = orderById.get(String(link.order_id))
    const hold = holdById.get(String(link.order_id))
    if (!order || !hold || order.payment_status !== 'paid' ||
        order.author_page_id !== access.authorPageId || hold.id !== link.hold_id ||
        (access.role === 'reader' && order.buyer_id !== uid)) continue
    const books = (order.items || []).filter((item) => String(item.product_type || '').toLowerCase() === 'book')
    if (!books.length) continue
    output.push({
      id: order.id,
      orderNumber: order.order_number || order.order_id || order.id,
      bookTitles: books.map((item) => item.product_title).filter(Boolean),
      paymentVerified: true,
      isPhysicalBook: true,
      holdStatus: hold.status,
      holdAmountCents: hold.held_amount_cents,
      paidAt: order.paid_at || order.created_at,
      readerConfirmedAt: hold.reader_confirmed_at,
      orderStatus: order.order_status || order.status || '',
      releaseSource: hold.release_source,
      deliveryCompany: hold.delivery_company || '',
      trackingNumber: hold.tracking_number || '',
      shippingProofReady: Array.isArray(hold.proof_refs) && hold.proof_refs.length > 0,
      popupSeen: Boolean(access.role === 'author' ? link.author_popup_seen_at : link.reader_popup_seen_at),
      holdId: hold.id,
    })
  }

  return { role: access.role, orders: output }
}

export async function markBookChatPopupSeen(userId, conversationId, orderId) {
  const uid = requireId(userId)
  const cid = requireId(conversationId)
  const oid = requireId(orderId)
  const access = await getRole(uid, cid)
  const { data: link, error: linkError } = await supabase
    .from('author_store_book_chat_links')
    .select('order_id')
    .eq('conversation_id', cid)
    .eq('order_id', oid)
    .maybeSingle()
  failIf(linkError)
  if (!link) throw new BookChatError(404, 'Book order not found')

  const { data: order, error: orderError } = await supabase
    .from('author_store_orders')
    .select('buyer_id,author_page_id,payment_status')
    .eq('id', oid)
    .maybeSingle()
  failIf(orderError)
  if (!order || order.payment_status !== 'paid' || order.author_page_id !== access.authorPageId ||
      (access.role === 'reader' && order.buyer_id !== uid)) {
    throw new BookChatError(403, 'Book order access denied')
  }

  const column = access.role === 'author' ? 'author_popup_seen_at' : 'reader_popup_seen_at'
  const { error } = await supabase
    .from('author_store_book_chat_links')
    .update({ [column]: new Date().toISOString() })
    .eq('order_id', oid)
    .eq('conversation_id', cid)
    .is(column, null)
  failIf(error)
  return { ok: true }
}
