import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { createSecurityGate } from '../middleware/securityGate.middleware.js'
import { guardSecurityMutation } from '../services/tamperGuard.service.js'
import {
  changePasskeyPin,
  disablePasskeyPin,
  getPasskeyPinEvents,
  getPasskeyPinStatus,
  setupPasskeyPin,
  verifyPasskeyPin,
} from '../controllers/adminPasskeyPin.controller.js'

const router = express.Router()

const passkeyPinMutationGate = createSecurityGate({
  gateId: 'admin_passkey_pin_mutation',
  roles: ['owner', 'admin', 'staff'],
  allowOwner: true,
  allowInSafeMode: false,
})

const passkeyPinVerifyGate = createSecurityGate({
  gateId: 'admin_passkey_pin_verify',
  roles: ['owner', 'admin', 'staff'],
  allowOwner: true,
  allowInSafeMode: true,
})

const observePasskeyPinDisable = (req, res, next) => {
  const role = String(req.admin?.role || '').trim().toLowerCase()
  const authorized = ['owner', 'admin', 'staff'].includes(role)

  guardSecurityMutation({
    target: 'security_config',
    action: 'disable',
    actor:
      req.admin?.admin_id
      || req.admin?.id
      || req.admin?.email
      || role
      || 'admin',
    authorized,
    allowInSafeMode: false,
    reason: authorized
      ? 'Passkey PIN disable attempted during protected state'
      : 'Unauthorized Passkey PIN disable attempted',
    details: {
      control: 'admin_passkey_pin',
      role: role || 'unknown',
      path: req.originalUrl || req.path || '',
    },
  })

  return next()
}

router.use(requireAdmin)

router.get('/status', getPasskeyPinStatus)
router.post('/setup', passkeyPinMutationGate, setupPasskeyPin)
router.post('/verify', passkeyPinVerifyGate, verifyPasskeyPin)
router.post('/change', passkeyPinMutationGate, changePasskeyPin)
router.post(
  '/disable',
  observePasskeyPinDisable,
  passkeyPinMutationGate,
  disablePasskeyPin
)
router.get('/events', getPasskeyPinEvents)

export default router
