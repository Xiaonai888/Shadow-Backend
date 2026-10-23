import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { createSecurityGate } from '../middleware/securityGate.middleware.js'
import { guardSecurityMutation } from '../services/tamperGuard.service.js'
import {
  addAdminTrustedIp,
  getAdminGuardEvents,
  getAdminGuardOverview,
  getAdminGuardStates,
  getAdminTrustedDevices,
  getAdminTrustedIps,
  permanentBlockAdminGuard,
  releaseAdminGuardBlock,
  revokeAdminTrustedDevice,
  revokeAdminTrustedIp,
  unblockAdminGuardPermanent,
} from '../controllers/adminLoginGuard.controller.js'

const router = express.Router()
const loginGuardLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(
    req.admin?.admin_id || req.admin?.id || req.admin?.sub || req.admin?.email || ipKeyGenerator(req.ip)
  ),
  message: {
    ok: false,
    message: 'Too many requests. Please try again later.',
  },
})

const loginSecurityMutationGate = createSecurityGate({
  gateId: 'admin_login_security_mutation',
  roles: ['owner', 'admin'],
  allowOwner: true,
  allowInSafeMode: false,
})

const loginSecurityDefenseGate = createSecurityGate({
  gateId: 'admin_login_security_defense',
  roles: ['owner', 'admin'],
  allowOwner: true,
  allowInSafeMode: true,
})

const observeLoginSecurityWeakening = (action) => (req, res, next) => {
  const role = String(req.admin?.role || '').trim().toLowerCase()
  const authorized = role === 'owner' || role === 'admin'

  guardSecurityMutation({
    target: 'security_config',
    action,
    actor:
      req.admin?.admin_id
      || req.admin?.id
      || req.admin?.email
      || role
      || 'admin',
    authorized,
    allowInSafeMode: false,
    reason: authorized
      ? 'Admin Login Guard protection weakening attempted during protected state'
      : 'Unauthorized Admin Login Guard security mutation attempted',
    details: {
      control: 'admin_login_guard',
      role: role || 'unknown',
      state_id: req.params?.stateId || null,
      ip_id: req.params?.ipId || null,
      path: req.originalUrl || req.path || '',
    },
  })

  return next()
}

router.get('/overview', requireAdmin, loginGuardLimiter, getAdminGuardOverview)
router.get('/states', requireAdmin, loginGuardLimiter, getAdminGuardStates)
router.get('/events', requireAdmin, loginGuardLimiter, getAdminGuardEvents)
router.patch(
  '/states/:stateId/release',
  requireAdmin,
  loginGuardLimiter,
  observeLoginSecurityWeakening('release'),
  loginSecurityMutationGate,
  releaseAdminGuardBlock
)
router.patch(
  '/states/:stateId/permanent-block',
  requireAdmin,
  loginGuardLimiter,
  loginSecurityDefenseGate,
  permanentBlockAdminGuard
)
router.patch(
  '/states/:stateId/unblock',
  requireAdmin,
  loginGuardLimiter,
  observeLoginSecurityWeakening('unblock'),
  loginSecurityMutationGate,
  unblockAdminGuardPermanent
)
router.get('/trusted-devices', requireAdmin, loginGuardLimiter, getAdminTrustedDevices)
router.patch(
  '/trusted-devices/:deviceId/revoke',
  requireAdmin,
  loginGuardLimiter,
  loginSecurityDefenseGate,
  revokeAdminTrustedDevice
)
router.get('/trusted-ips', requireAdmin, loginGuardLimiter, getAdminTrustedIps)
router.post(
  '/trusted-ips',
  requireAdmin,
  loginGuardLimiter,
  observeLoginSecurityWeakening('config_change'),
  loginSecurityMutationGate,
  addAdminTrustedIp
)
router.patch(
  '/trusted-ips/:ipId/revoke',
  requireAdmin,
  loginGuardLimiter,
  loginSecurityDefenseGate,
  revokeAdminTrustedIp
)

export default router
