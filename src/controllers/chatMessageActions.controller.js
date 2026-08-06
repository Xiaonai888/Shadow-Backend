import {
  deleteMessages,
  editMessage,
  forwardMessages,
  listPinnedMessages,
  pinMessage,
  replyToMessage,
  unpinMessage,
} from '../services/chatMessageActions.service.js'
import {
  ChatServiceError,
} from '../services/chat.service.js'

function handleChatActionError(
  res,
  error,
  label
) {
  console.error(label, {
    message:
      error?.message || error,
    cause:
      error?.cause?.message || null,
  })

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

function getMessageIds(req) {
  const bodyIds =
    req.body?.message_ids ||
    req.body?.messageIds

  if (Array.isArray(bodyIds)) {
    return bodyIds
  }

  const singleId =
    req.params?.messageId ||
    req.body?.message_id ||
    req.body?.messageId

  return singleId
    ? [singleId]
    : []
}

export async function replyToMessageController(
  req,
  res
) {
  try {
    const message =
      await replyToMessage({
        userId:
          req.user?.user_id,
        conversationId:
          req.params
            .conversationId,
        replyToMessageId:
          req.params.messageId ||
          req.body
            ?.reply_to_message_id ||
          req.body
            ?.replyToMessageId,
        message:
          req.body?.message ||
          req.body?.body,
      })

    return res.status(201).json({
      ok: true,
      message,
    })
  } catch (error) {
    return handleChatActionError(
      res,
      error,
      'REPLY CHAT MESSAGE ERROR'
    )
  }
}

export async function editMessageController(
  req,
  res
) {
  try {
    const message =
      await editMessage({
        userId:
          req.user?.user_id,
        conversationId:
          req.params
            .conversationId,
        messageId:
          req.params.messageId ||
          req.body?.message_id ||
          req.body?.messageId,
        message:
          req.body?.message ||
          req.body?.body,
      })

    return res.status(200).json({
      ok: true,
      message,
    })
  } catch (error) {
    return handleChatActionError(
      res,
      error,
      'EDIT CHAT MESSAGE ERROR'
    )
  }
}

export async function deleteMessagesController(
  req,
  res
) {
  try {
    const result =
      await deleteMessages({
        userId:
          req.user?.user_id,
        conversationId:
          req.params
            .conversationId,
        messageIds:
          getMessageIds(req),
      })

    return res.status(200).json({
      ok: true,
      ...result,
    })
  } catch (error) {
    return handleChatActionError(
      res,
      error,
      'DELETE CHAT MESSAGES ERROR'
    )
  }
}

export async function pinMessageController(
  req,
  res
) {
  try {
    const pin =
      await pinMessage({
        userId:
          req.user?.user_id,
        conversationId:
          req.params
            .conversationId,
        messageId:
          req.params.messageId ||
          req.body?.message_id ||
          req.body?.messageId,
      })

    return res.status(201).json({
      ok: true,
      pin,
    })
  } catch (error) {
    return handleChatActionError(
      res,
      error,
      'PIN CHAT MESSAGE ERROR'
    )
  }
}

export async function unpinMessageController(
  req,
  res
) {
  try {
    const result =
      await unpinMessage({
        userId:
          req.user?.user_id,
        conversationId:
          req.params
            .conversationId,
        messageId:
          req.params.messageId ||
          req.body?.message_id ||
          req.body?.messageId,
      })

    return res.status(200).json({
      ok: true,
      ...result,
    })
  } catch (error) {
    return handleChatActionError(
      res,
      error,
      'UNPIN CHAT MESSAGE ERROR'
    )
  }
}

export async function listPinnedMessagesController(
  req,
  res
) {
  try {
    const pins =
      await listPinnedMessages({
        userId:
          req.user?.user_id,
        conversationId:
          req.params
            .conversationId,
      })

    return res.status(200).json({
      ok: true,
      pins,
    })
  } catch (error) {
    return handleChatActionError(
      res,
      error,
      'LIST PINNED CHAT MESSAGES ERROR'
    )
  }
}

export async function forwardMessagesController(
  req,
  res
) {
  try {
    const result =
      await forwardMessages({
        userId:
          req.user?.user_id,
        sourceConversationId:
          req.params
            .conversationId,
        targetConversationId:
          req.body
            ?.target_conversation_id ||
          req.body
            ?.targetConversationId,
        messageIds:
          getMessageIds(req),
      })

    return res.status(201).json({
      ok: true,
      ...result,
    })
  } catch (error) {
    return handleChatActionError(
      res,
      error,
      'FORWARD CHAT MESSAGES ERROR'
    )
  }
}
