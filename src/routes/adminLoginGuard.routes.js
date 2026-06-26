import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
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

router.use(requireAdmin)

router.get('/overview', getAdminGuardOverview)
router.get('/states', getAdminGuardStates)
router.get('/events', getAdminGuardEvents)
router.patch('/states/:stateId/release', releaseAdminGuardBlock)
router.patch('/states/:stateId/permanent-block', permanentBlockAdminGuard)
router.patch('/states/:stateId/unblock', unblockAdminGuardPermanent)
router.get('/trusted-devices', getAdminTrustedDevices)
router.patch('/trusted-devices/:deviceId/revoke', revokeAdminTrustedDevice)
router.get('/trusted-ips', getAdminTrustedIps)
router.post('/trusted-ips', addAdminTrustedIp)
router.patch('/trusted-ips/:ipId/revoke', revokeAdminTrustedIp)

export default router
