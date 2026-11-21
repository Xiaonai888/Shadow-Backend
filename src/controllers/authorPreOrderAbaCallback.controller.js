import { processAuthorPreOrderAbaCallback } from '../services/authorPreOrderAbaCallback.service.js'

const MAX_CALLBACK_BODY_BYTES = 24_576

export async function handleAuthorPreOrderAbaCallback(req, res) {
  res.set('Cache-Control', 'no-store')
  res.set('X-Content-Type-Options', 'nosniff')

  const reportedBytes = Number(req.get('content-length') || 0)
  if (reportedBytes > MAX_CALLBACK_BODY_BYTES) {
    return res.status(413).json({ ok: false, code: 'PRE_ORDER_CALLBACK_TOO_LARGE' })
  }
  let size
  try {
    size = Buffer.byteLength(JSON.stringify(req.body ?? null), 'utf8')
  } catch {
    return res.status(400).json({ ok: false, code: 'PRE_ORDER_CALLBACK_INVALID' })
  }
  if (size > MAX_CALLBACK_BODY_BYTES) {
    return res.status(413).json({ ok: false, code: 'PRE_ORDER_CALLBACK_TOO_LARGE' })
  }

  try {
    await processAuthorPreOrderAbaCallback(req.body)
    return res.status(200).json({ ok: true })
  } catch (error) {
    const code = String(error?.code || '')
    const status = Number(error?.statusCode)
    if (!/^PRE_ORDER_[A-Z0-9_]+$/.test(code) || !Number.isInteger(status)) {
      console.error('PRE_ORDER_ABA_CALLBACK_UNEXPECTED:', String(error?.name || 'error'))
      return res.status(503).json({ ok: false, code: 'PRE_ORDER_CALLBACK_RETRY' })
    }
    if (status === 400 || status === 404) {
      return res.status(status).json({ ok: false, code })
    }
    console.error('PRE_ORDER_ABA_CALLBACK_RETRY:', code)
    return res.status(503).json({ ok: false, code: 'PRE_ORDER_CALLBACK_RETRY' })
  }
}
