import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { verifyAdminPasskeyPin } from '../services/adminPasskeyPin.service.js'

const SCOPE = 'staff_accounts'
const HEADER = 'x-staff-accounts-unlock'
const TTL_SECONDS = 300

function getContext(req) {
  const authorization = String(req.headers.authorization || '')
  const match = /^Bearer\s+(\S+)$/i.exec(authorization)
  const adminId = String(req.admin?.admin_id || req.admin?.id || '').trim()
  const email = String(req.admin?.email || '').trim().toLowerCase()
  const secret = process.env.JWT_SECRET
  if (!match || !email || !secret || !req.admin) return null
  return {
    subject: adminId || email,
    binding: createHash('sha256').update(match[1]).digest('hex'),
    key: createHmac('sha256', secret).update('shadow:staff-accounts:unlock:v1').digest(),
  }
}

function deny(res, status = 403, code = 'STAFF_ACCOUNTS_LOCKED', message = 'Unlock Staff Accounts with your Passkey PIN.') {
  return res.status(status).json({ ok: false, code, message })
}

export async function unlockStaffAccounts(req, res) {
  res.set('Cache-Control', 'no-store, private')
  try {
    const context = getContext(req)
    if (!context) return deny(res)
    const pin = String(req.body?.pin || '')
    if (!/^\d{6}$/.test(pin)) return deny(res, 400, 'PASSKEY_REQUIRED', 'Enter your 6-digit Passkey PIN.')
    const result = await verifyAdminPasskeyPin({ admin: req.admin, req, pin, purpose: 'staff_accounts_unlock' })
    if (result?.ok !== true) {
      return deny(res, result?.status || 403, result?.code || 'PASSKEY_INVALID', result?.message || 'Passkey verification failed.')
    }
    const unlockToken = jwt.sign({ scope: SCOPE, binding: context.binding }, context.key, {
      algorithm: 'HS256',
      subject: context.subject,
      audience: 'shadow-admin-staff-accounts',
      issuer: 'shadow-backend',
      expiresIn: TTL_SECONDS,
    })
    return res.json({ ok: true, unlockToken, expiresIn: TTL_SECONDS })
  } catch {
    return deny(res, 500, 'STAFF_ACCOUNTS_UNLOCK_FAILED', 'Unable to verify Passkey PIN.')
  }
}

export function requireStaffAccountsPasskey(req, res, next) {
  res.set('Cache-Control', 'no-store, private')
  try {
    const context = getContext(req)
    const token = req.get(HEADER)
    if (!context || !token || token.length > 4096) return deny(res)
    const grant = jwt.verify(token, context.key, {
      algorithms: ['HS256'],
      subject: context.subject,
      audience: 'shadow-admin-staff-accounts',
      issuer: 'shadow-backend',
      maxAge: TTL_SECONDS,
    })
    if (grant.scope !== SCOPE || typeof grant.binding !== 'string' || !/^[a-f0-9]{64}$/.test(grant.binding)) return deny(res)
    if (!timingSafeEqual(Buffer.from(grant.binding, 'hex'), Buffer.from(context.binding, 'hex'))) return deny(res)
  } catch {
    return deny(res)
  }
  return next()
}
