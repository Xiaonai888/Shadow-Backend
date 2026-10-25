import {
  BookNoticeError,
  listBookChatNotices,
  markBookChatNoticeSeen,
} from '../services/authorStoreBookChatNotices.service.js'

function fail(res, error) {
  const status = error instanceof BookNoticeError ? error.status : 500
  if (status === 500) console.error('BOOK CHAT NOTICE ERROR', { code: error?.code, message: error?.message })
  return res.status(status).json({
    ok: false,
    message: status === 500 ? 'Book notifications are unavailable' : error.message,
  })
}

export async function getConversationBookNotices(req, res) {
  res.set('Cache-Control', 'private, no-store')
  res.set('Vary', 'Authorization')
  try {
    const data = await listBookChatNotices(
      req.user?.user_id,
      req.params.conversationId,
      req.query?.page === undefined ? 1 : req.query.page
    )
    return res.status(200).json({ ok: true, ...data })
  } catch (error) {
    return fail(res, error)
  }
}

export async function markConversationBookNoticeSeen(req, res) {
  res.set('Cache-Control', 'private, no-store')
  res.set('Vary', 'Authorization')
  try {
    const notice = await markBookChatNoticeSeen(
      req.user?.user_id,
      req.params.conversationId,
      req.params.noticeId
    )
    return res.status(200).json({ ok: true, notice })
  } catch (error) {
    return fail(res, error)
  }
}
