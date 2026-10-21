import {
  getReaderCommentSettings,
  saveReaderCommentSettings,
  READER_COMMENT_AUDIENCES,
} from '../services/readerCommentSettings.service.js'

function getUserId(req) {
  return String(req.user?.user_id || req.user?.id || '').trim()
}

function sendError(res, status, code, message) {
  res.set('Cache-Control', 'private, no-store')
  return res.status(status).json({ ok: false, code, message })
}

export async function getMyReaderCommentSettings(req, res) {
  const userId = getUserId(req)
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Please sign in again.')

  try {
    const settings = await getReaderCommentSettings(userId)
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, settings })
  } catch (error) {
    console.error('GET READER COMMENT SETTINGS ERROR:', error)
    return sendError(res, 500, 'SETTINGS_ERROR', 'Could not load comment settings.')
  }
}

export async function updateMyReaderCommentSettings(req, res) {
  const userId = getUserId(req)
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Please sign in again.')

  const body = req.body
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !READER_COMMENT_AUDIENCES.has(body.audience) ||
    typeof body.allowComments !== 'boolean' ||
    typeof body.filterSpam !== 'boolean' ||
    typeof body.commentApproval !== 'boolean'
  ) {
    return sendError(res, 400, 'INVALID_SETTINGS', 'Invalid comment settings.')
  }

  try {
    const settings = await saveReaderCommentSettings(userId, body)
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, settings })
  } catch (error) {
    console.error('UPDATE READER COMMENT SETTINGS ERROR:', error)
    return sendError(res, 500, 'SETTINGS_ERROR', 'Could not save comment settings.')
  }
}
