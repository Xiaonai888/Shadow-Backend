import {
  blockConversation,
  ChatBlockError,
} from '../services/chatBlock.service.js'

export async function blockConversationController(
  req,
  res
) {
  try {
    const conversation =
      await blockConversation({
        userId: req.user?.user_id,
        conversationId:
          req.params.conversationId,
      })

    return res.status(200).json({
      ok: true,
      conversation,
    })
  } catch (error) {
    console.error(
      'BLOCK CHAT CONVERSATION ERROR',
      {
        message: error?.message || error,
        cause:
          error?.cause?.message || null,
      }
    )

    if (error instanceof ChatBlockError) {
      return res.status(error.status).json({
        ok: false,
        code: error.code,
        message: error.message,
      })
    }

    return res.status(500).json({
      ok: false,
      code: 'CHAT_BLOCK_SERVER_ERROR',
      message:
        'Blocking is temporarily unavailable',
    })
  }
}
