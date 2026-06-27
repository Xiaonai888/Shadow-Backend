import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  emergencyResetDevices,
  getAdminDeviceAccessOverview,
  getAdminDeviceEvents,
  getAdminDevices,
  logoutCurrentDevice,
  revokeAdminDevice,
} from '../controllers/adminDeviceAccess.controller.js'

const router = express.Router()

router.use(requireAdmin)

router.get('/overview', getAdminDeviceAccessOverview)
router.get('/devices', getAdminDevices)
router.get('/events', getAdminDeviceEvents)
router.post('/logout-current', logoutCurrentDevice)
router.patch('/devices/:deviceId/revoke', revokeAdminDevice)
router.post('/emergency-reset', emergencyResetDevices)

export default router
