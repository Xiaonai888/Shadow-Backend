import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { createSecurityGate } from '../middleware/securityGate.middleware.js'
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

router.use(requireAdmin)

router.get('/status', getPasskeyPinStatus)
router.post('/setup', passkeyPinMutationGate, setupPasskeyPin)
router.post('/verify', passkeyPinVerifyGate, verifyPasskeyPin)
router.post('/change', passkeyPinMutationGate, changePasskeyPin)
router.post('/disable', passkeyPinMutationGate, disablePasskeyPin)
router.get('/events', getPasskeyPinEvents)

export default router
