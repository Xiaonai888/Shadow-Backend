import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { createSecurityGate } from '../middleware/securityGate.middleware.js'
import {
  emergencyResetDevices,
  getAdminDeviceAccessOverview,
  getAdminDeviceEvents,
  getAdminDevices,
  logoutCurrentDevice,
  revokeAdminDevice,
  getAdminSecurityAlerts,
  markAdminSecurityAlertRead,
  markAllAdminSecurityAlertsReadController,
} from '../controllers/adminDeviceAccess.controller.js'

const router = express.Router()

const deviceMutationGate = createSecurityGate({
  gateId: 'admin_device_access_mutation',
  roles: ['owner', 'admin'],
  allowOwner: true,
  allowInSafeMode: false,
})

const emergencyRecoveryGate = createSecurityGate({
  gateId: 'admin_device_access_emergency_recovery',
  roles: ['owner', 'admin'],
  allowOwner: true,
  allowInSafeMode: true,
})

router.use(requireAdmin)

router.get('/overview', getAdminDeviceAccessOverview)
router.get('/devices', getAdminDevices)
router.get('/events', getAdminDeviceEvents)
router.post('/logout-current', deviceMutationGate, logoutCurrentDevice)
router.patch('/devices/:deviceId/revoke', deviceMutationGate, revokeAdminDevice)
router.post('/emergency-reset', emergencyRecoveryGate, emergencyResetDevices)
router.get('/security-alerts', getAdminSecurityAlerts)
router.patch('/security-alerts/read-all', markAllAdminSecurityAlertsReadController)
router.patch('/security-alerts/:alertId/read', markAdminSecurityAlertRead)

export default router
