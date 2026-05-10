
import jwt from 'jsonwebtoken'

export function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null

    if (!token) {
      return res.status(401).json({
        ok: false,
        message: 'Admin token required',
      })
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({
        ok: false,
        message: 'JWT_SECRET is missing',
      })
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (decoded.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        message: 'Admin access only',
      })
    }

    req.admin = decoded
    next()
  } catch (error) {
    return res.status(401).json({
      ok: false,
      message: 'Invalid or expired admin token',
    })
  }
}
