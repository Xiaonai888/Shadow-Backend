import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
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

const adminDeviceAccessIdentity = (req) => String(
  req.admin?.admin_id ||
  req.admin?.id ||
  req.admin?.sub ||
  req.admin?.email ||
  ipKeyGenerator(req.ip)
)

const adminDeviceReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminDeviceAccessIdentity,
  message: {
    ok: false,
    code: 'ADMIN_DEVICE_READ_RATE_LIMIT',
    message: 'Too many device requests. Please try again shortly.',
  },
})

const adminDeviceActionLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminDeviceAccessIdentity,
  message: {
    ok: false,
    code: 'ADMIN_DEVICE_ACTION_RATE_LIMIT',
    message: 'Too many device actions. Please try again shortly.',
  },
})

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

router.get('/overview', adminDeviceReadLimit, getAdminDeviceAccessOverview)
router.get('/devices', adminDeviceReadLimit, getAdminDevices)
router.get('/events', adminDeviceReadLimit, getAdminDeviceEvents)
router.post('/logout-current', adminDeviceActionLimit, deviceMutationGate, logoutCurrentDevice)
router.patch('/devices/:deviceId/revoke', adminDeviceActionLimit, deviceMutationGate, revokeAdminDevice)
router.post('/emergency-reset', adminDeviceActionLimit, emergencyRecoveryGate, emergencyResetDevices)
router.get('/security-alerts', adminDeviceReadLimit, getAdminSecurityAlerts)
router.patch('/security-alerts/read-all', adminDeviceActionLimit, markAllAdminSecurityAlertsReadController)
router.patch('/security-alerts/:alertId/read', adminDeviceActionLimit, markAdminSecurityAlertRead)

export default router
