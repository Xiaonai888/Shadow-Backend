import {
  ChatQuickContactsError,
  listChatQuickContacts,
  touchChatPresence,
} from '../services/chatQuickContacts.service.js'

function handleError(res, error, label) {
  console.error(label, {
    message: error?.message || error,
    cause: error?.cause?.message || null,
  })

  if (
    error instanceof
    ChatQuickContactsError
  ) {
    return res.status(error.status).json({
      ok: false,
      code: error.code,
      message: error.message,
    })
  }

  return res.status(500).json({
    ok: false,
    code:
      'CHAT_QUICK_CONTACTS_SERVER_ERROR',
    message:
      'Quick contacts are temporarily unavailable',
  })
}

export async function listChatQuickContactsController(
  req,
  res
) {
  try {
    const contacts =
      await listChatQuickContacts({
        userId: req.user?.user_id,
        limit: req.query?.limit,
      })

    return res.status(200).json({
      ok: true,
      contacts,
    })
  } catch (error) {
    return handleError(
      res,
      error,
      'LIST CHAT QUICK CONTACTS ERROR'
    )
  }
}

export async function touchChatPresenceController(
  req,
  res
) {
  try {
    const result = await touchChatPresence({
      userId: req.user?.user_id,
    })

    return res.status(200).json({
      ok: true,
      ...result,
    })
  } catch (error) {
    return handleError(
      res,
      error,
      'TOUCH CHAT PRESENCE ERROR'
    )
  }
}
