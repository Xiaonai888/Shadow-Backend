import jwt from 'jsonwebtoken'
import { validateReaderDeviceSession } from '../services/readerDeviceSessions.service.js'

const READER_SESSION_DAYS = 60
const RENEW_AFTER_SECONDS = 24 * 60 * 60

function renewReaderToken(decoded) {
  const { iat, exp, nbf, ...payload } = decoded

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: `${READER_SESSION_DAYS}d`,
  })
}

export async function requireUser(req, res, next) {
  let token = ''

  try {
    const authHeader = req.headers.authorization || ''

    token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : ''

    if (!token) {
      return res.status(401).json({
        ok: false,
        code: 'TOKEN_REQUIRED',
        message: 'Token is required',
      })
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (decoded.type !== 'reader') {
      console.warn(
        'READER_AUTH_DENIED',
        JSON.stringify({
          reason: 'wrong_token_type',
          token_type: decoded.type || null,
          path: req.originalUrl,
          method: req.method,
        })
      )

      return res.status(403).json({
        ok: false,
        code: 'WRONG_TOKEN_TYPE',
        message: 'Reader account token is required',
      })
    }

    if (!decoded.session_id || !decoded.device_id || !decoded.jwt_id) {
      return res.status(401).json({
        ok: false,
        code: 'READER_SESSION_REQUIRED',
        message: 'Please sign in again to continue.',
      })
    }

    let session
    try {
      session = await validateReaderDeviceSession(decoded)
    } catch (error) {
      console.error('READER_SESSION_CHECK_ERROR:', error)
      return res.status(503).json({
        ok: false,
        code: 'READER_SESSION_UNAVAILABLE',
        message: 'Session verification is temporarily unavailable',
      })
    }

    if (!session.ok) {
      return res.status(401).json({
        ok: false,
        code: session.code,
        message: 'Reader session is invalid or expired',
      })
    }

    const now = Math.floor(Date.now() / 1000)

    if (!decoded.iat || now - decoded.iat >= RENEW_AFTER_SECONDS) {
      res.set('X-Reader-Token', renewReaderToken(decoded))
    }

    req.user = decoded
    return next()
  } catch (error) {
    const tokenInfo = token ? jwt.decode(token) : null

    console.warn(
      'READER_AUTH_FAIL',
      JSON.stringify({
        reason: error?.name || 'UnknownError',
        detail: error?.message || '',
        user_id: tokenInfo?.user_id || null,
        issued_at: tokenInfo?.iat
          ? new Date(tokenInfo.iat * 1000).toISOString()
          : null,
        expires_at: tokenInfo?.exp
          ? new Date(tokenInfo.exp * 1000).toISOString()
          : null,
        secret_configured: Boolean(process.env.JWT_SECRET),
        path: req.originalUrl,
        method: req.method,
      })
    )

    const expired = error?.name === 'TokenExpiredError'

    return res.status(401).json({
      ok: false,
      code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      message: expired ? 'Token expired' : 'Invalid token',
    })
  }
}
