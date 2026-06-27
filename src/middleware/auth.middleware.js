import jwt from 'jsonwebtoken'
import { validateAdminSession } from '../services/adminDeviceAccess.service.js'

export async function requireAdmin(req, res, next) {
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
    const role = String(decoded.role || '').trim().toLowerCase()
    const allowedRoles = ['owner', 'admin']

    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        ok: false,
        message: `Owner or admin access only. Current role: ${decoded.role || 'missing'}`,
      })
    }

    const sessionCheck = await validateAdminSession({ decoded, req })

    if (!sessionCheck.ok) {
      return res.status(sessionCheck.status || 401).json({
        ok: false,
        code: sessionCheck.code || 'ADMIN_SESSION_INVALID',
        message: sessionCheck.message || 'Admin session is invalid. Please login again.',
      })
    }

    req.admin = {
      ...decoded,
      session: sessionCheck.session,
      device: sessionCheck.device,
    }

    next()
  } catch (error) {
    return res.status(401).json({
      ok: false,
      message: 'Invalid or expired admin token',
    })
  }
}
