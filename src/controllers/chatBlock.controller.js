import {
  blockConversation,
  ChatBlockError,
  getConversationBlockStatus,
  unblockConversation,
} from '../services/chatBlock.service.js'

function handleBlockError(
  error,
  res,
  fallbackCode,
  fallbackMessage
) {
  console.error(fallbackCode, {
    message: error?.message || error,
    cause: error?.cause?.message || null,
  })

  if (error instanceof ChatBlockError) {
    return res.status(error.status).json({
      ok: false,
      code: error.code,
      message: error.message,
    })
  }

  return res.status(500).json({
    ok: false,
    code: fallbackCode,
    message: fallbackMessage,
  })
}

export async function getConversationBlockStatusController(
  req,
  res
) {
  try {
    const blockStatus =
      await getConversationBlockStatus({
        userId: req.user?.user_id,
        conversationId:
          req.params.conversationId,
      })

    return res.status(200).json({
      ok: true,
      block_status: blockStatus,
    })
  } catch (error) {
    return handleBlockError(
      error,
      res,
      'CHAT_BLOCK_STATUS_SERVER_ERROR',
      'Block status is temporarily unavailable'
    )
  }
}

export async function blockConversationController(
  req,
  res
) {
  try {
    const result = await blockConversation({
      userId: req.user?.user_id,
      conversationId:
        req.params.conversationId,
    })

    return res.status(200).json({
      ok: true,
      ...result,
    })
  } catch (error) {
    return handleBlockError(
      error,
      res,
      'CHAT_BLOCK_SERVER_ERROR',
      'Blocking is temporarily unavailable'
    )
  }
}

export async function unblockConversationController(
  req,
  res
) {
  try {
    const result =
      await unblockConversation({
        userId: req.user?.user_id,
        conversationId:
          req.params.conversationId,
      })

    return res.status(200).json({
      ok: true,
      ...result,
    })
  } catch (error) {
    return handleBlockError(
      error,
      res,
      'CHAT_UNBLOCK_SERVER_ERROR',
      'Unblocking is temporarily unavailable'
    )
  }
}
