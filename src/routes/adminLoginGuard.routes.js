import express from 'express'
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

router.use(requireAdmin)

router.get('/overview', getAdminGuardOverview)
router.get('/states', getAdminGuardStates)
router.get('/events', getAdminGuardEvents)
router.patch(
  '/states/:stateId/release',
  observeLoginSecurityWeakening('release'),
  loginSecurityMutationGate,
  releaseAdminGuardBlock
)
router.patch(
  '/states/:stateId/permanent-block',
  loginSecurityDefenseGate,
  permanentBlockAdminGuard
)
router.patch(
  '/states/:stateId/unblock',
  observeLoginSecurityWeakening('unblock'),
  loginSecurityMutationGate,
  unblockAdminGuardPermanent
)
router.get('/trusted-devices', getAdminTrustedDevices)
router.patch(
  '/trusted-devices/:deviceId/revoke',
  loginSecurityDefenseGate,
  revokeAdminTrustedDevice
)
router.get('/trusted-ips', getAdminTrustedIps)
router.post(
  '/trusted-ips',
  observeLoginSecurityWeakening('config_change'),
  loginSecurityMutationGate,
  addAdminTrustedIp
)
router.patch(
  '/trusted-ips/:ipId/revoke',
  loginSecurityDefenseGate,
  revokeAdminTrustedIp
)

export default router
