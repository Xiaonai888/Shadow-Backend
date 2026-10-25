import {
  BookChatError,
  getBookChatOrders,
  markBookChatPopupSeen,
} from '../services/authorStoreBookChat.service.js'

function fail(res, error) {
  const status = error instanceof BookChatError ? error.status : 500
  if (status === 500) console.error('BOOK ORDER CHAT ERROR:', error)
  return res.status(status).json({ ok: false, message: status === 500 ? 'Book order chat unavailable' : error.message })
}

export async function getConversationBookOrders(req, res) {
  res.set('Cache-Control', 'private, no-store')
  res.set('Vary', 'Authorization')
  try {
    const data = await getBookChatOrders(req.user?.user_id, req.params.conversationId)
    return res.status(200).json({ ok: true, ...data })
  } catch (error) {
    return fail(res, error)
  }
}

export async function markConversationBookOrderPopupSeen(req, res) {
  res.set('Cache-Control', 'private, no-store')
  res.set('Vary', 'Authorization')
  try {
    await markBookChatPopupSeen(req.user?.user_id, req.params.conversationId, req.params.orderId)
    return res.status(200).json({ ok: true })
  } catch (error) {
    return fail(res, error)
  }
}
