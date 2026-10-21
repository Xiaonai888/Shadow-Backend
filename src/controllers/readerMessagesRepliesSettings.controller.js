import {
  getReaderMessagesRepliesSettings,
  saveReaderMessagesRepliesSettings,
  MESSAGE_AUDIENCES,
  REPLY_AUDIENCES,
} from '../services/readerMessagesRepliesSettings.service.js'

function getUserId(req) {
  return String(req.user?.user_id || req.user?.id || '').trim()
}

function sendError(res, status, code, message) {
  res.set('Cache-Control', 'private, no-store')
  return res.status(status).json({ ok: false, code, message })
}

export async function getMyReaderMessagesRepliesSettings(req, res) {
  const userId = getUserId(req)
  if (!userId) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Please sign in again.')
  }

  try {
    const settings = await getReaderMessagesRepliesSettings(userId)
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, settings })
  } catch (error) {
    console.error('GET READER MESSAGES REPLIES SETTINGS ERROR:', error)
    return sendError(res, 500, 'SETTINGS_ERROR', 'Could not load messages and replies settings.')
  }
}

export async function updateMyReaderMessagesRepliesSettings(req, res) {
  const userId = getUserId(req)
  if (!userId) {
    return sendError(res, 401, 'UNAUTHORIZED', 'Please sign in again.')
  }

  const body = req.body
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !MESSAGE_AUDIENCES.has(body.messageAudience) ||
    typeof body.messageRequests !== 'boolean' ||
    !REPLY_AUDIENCES.has(body.replyAudience) ||
    typeof body.messageNotifications !== 'boolean'
  ) {
    return sendError(res, 400, 'INVALID_SETTINGS', 'Invalid messages and replies settings.')
  }

  try {
    const settings = await saveReaderMessagesRepliesSettings(userId, body)
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, settings })
  } catch (error) {
    console.error('UPDATE READER MESSAGES REPLIES SETTINGS ERROR:', error)
    return sendError(res, 500, 'SETTINGS_ERROR', 'Could not save messages and replies settings.')
  }
}
