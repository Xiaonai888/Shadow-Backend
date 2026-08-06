import {
  reportChatMessage,
} from '../services/chatMessageReport.service.js'
import {
  ChatServiceError,
} from '../services/chat.service.js'

function handleError(
  res,
  error
) {
  console.error(
    'REPORT CHAT MESSAGE ERROR',
    {
      message:
        error?.message || error,
      cause:
        error?.cause?.message || null,
    }
  )

  if (
    error instanceof
    ChatServiceError
  ) {
    return res
      .status(error.status)
      .json({
        ok: false,
        code: error.code,
        message: error.message,
      })
  }

  return res.status(500).json({
    ok: false,
    code: 'CHAT_SERVER_ERROR',
    message:
      'Chat is temporarily unavailable',
  })
}

export async function reportChatMessageController(
  req,
  res
) {
  try {
    const report =
      await reportChatMessage({
        userId:
          req.user?.user_id,
        conversationId:
          req.params
            .conversationId,
        messageId:
          req.params.messageId,
        reason:
          req.body?.reason,
        details:
          req.body?.details,
      })

    return res.status(201).json({
      ok: true,
      report,
    })
  } catch (error) {
    return handleError(res, error)
  }
}
