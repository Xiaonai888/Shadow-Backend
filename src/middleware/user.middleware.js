import jwt from 'jsonwebtoken'

export function requireUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : ''

    if (!token) {
      return res.status(401).json({
        ok: false,
        message: 'Token is required',
      })
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (decoded.type !== 'reader') {
      return res.status(403).json({
        ok: false,
        message: 'Reader account token is required',
      })
    }

    req.user = decoded

    return next()
  } catch (error) {
    return res.status(401).json({
      ok: false,
      message: 'Invalid or expired token',
    })
  }
}
