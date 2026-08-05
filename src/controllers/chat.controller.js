import {
  ChatServiceError,
  createReaderAuthorRequest,
  createReaderReaderRequest,
  decideMessageRequest,
  getConversationMessages,
  listMyConversations,
  markConversationRead,
  sendConversationMessage,
} from '../services/chat.service.js'

function handleChatError(res, error, label) {
  console.error(label, {
    message: error?.message || error,
    cause: error?.cause?.message || null,
  })

  if (error instanceof ChatServiceError) {
    return res.status(error.status).json({
      ok: false,
      code: error.code,
      message: error.message,
    })
  }

  return res.status(500).json({
    ok: false,
    code: 'CHAT_SERVER_ERROR',
    message: 'Chat is temporarily unavailable',
  })
}

export async function createReaderAuthorRequestController(
  req,
  res
) {
  try {
    const result = await createReaderAuthorRequest({
      readerUserId: req.user?.user_id,
      authorPageId:
        req.body?.author_page_id ||
        req.body?.authorPageId,
      message: req.body?.message,
    })

    return res.status(result.created ? 201 : 200).json({
      ok: true,
      created: result.created,
      conversation: result.conversation,
    })
  } catch (error) {
    return handleChatError(
      res,
      error,
      'CREATE READER AUTHOR CHAT REQUEST ERROR'
    )
  }
}

export async function createReaderReaderRequestController(
  req,
  res
) {
  try {
    const result = await createReaderReaderRequest({
      senderUserId: req.user?.user_id,
      targetUserId:
        req.body?.reader_user_id ||
        req.body?.readerUserId,
      message: req.body?.message,
    })

    return res.status(result.created ? 201 : 200).json({
      ok: true,
      created: result.created,
      conversation: result.conversation,
    })
  } catch (error) {
    return handleChatError(
      res,
      error,
      'CREATE READER READER CHAT REQUEST ERROR'
    )
  }
}

export async function listMyConversationsController(
  req,
  res
) {
  try {
    const conversations = await listMyConversations({
      userId: req.user?.user_id,
      status: req.query?.status,
    })

    return res.status(200).json({
      ok: true,
      conversations,
    })
  } catch (error) {
    return handleChatError(
      res,
      error,
      'LIST CHAT CONVERSATIONS ERROR'
    )
  }
}

export async function getConversationMessagesController(
  req,
  res
) {
  try {
    const result = await getConversationMessages({
      userId: req.user?.user_id,
      conversationId: req.params.conversationId,
      before: req.query?.before,
      limit: req.query?.limit,
    })

    return res.status(200).json({
      ok: true,
      ...result,
    })
  } catch (error) {
    return handleChatError(
      res,
      error,
      'GET CHAT MESSAGES ERROR'
    )
  }
}

export async function sendConversationMessageController(
  req,
  res
) {
  try {
    const message = await sendConversationMessage({
      userId: req.user?.user_id,
      conversationId: req.params.conversationId,
      message: req.body?.message,
    })

    return res.status(201).json({
      ok: true,
      message,
    })
  } catch (error) {
    return handleChatError(
      res,
      error,
      'SEND CHAT MESSAGE ERROR'
    )
  }
}

export async function decideMessageRequestController(
  req,
  res
) {
  try {
    const conversation = await decideMessageRequest({
      userId: req.user?.user_id,
      conversationId: req.params.conversationId,
      action: req.body?.action,
    })

    return res.status(200).json({
      ok: true,
      conversation,
    })
  } catch (error) {
    return handleChatError(
      res,
      error,
      'DECIDE CHAT REQUEST ERROR'
    )
  }
}

export async function markConversationReadController(
  req,
  res
) {
  try {
    const result = await markConversationRead({
      userId: req.user?.user_id,
      conversationId: req.params.conversationId,
    })

    return res.status(200).json({
      ok: true,
      ...result,
    })
  } catch (error) {
    return handleChatError(
      res,
      error,
      'MARK CHAT READ ERROR'
    )
  }
}
