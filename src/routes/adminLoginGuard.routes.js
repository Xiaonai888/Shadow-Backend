import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { createSecurityGate } from '../middleware/securityGate.middleware.js'
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

router.use(requireAdmin)

router.get('/overview', getAdminGuardOverview)
router.get('/states', getAdminGuardStates)
router.get('/events', getAdminGuardEvents)
router.patch(
  '/states/:stateId/release',
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
  loginSecurityMutationGate,
  addAdminTrustedIp
)
router.patch(
  '/trusted-ips/:ipId/revoke',
  loginSecurityDefenseGate,
  revokeAdminTrustedIp
)

export default router
