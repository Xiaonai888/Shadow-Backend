import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { createSecurityGate } from '../middleware/securityGate.middleware.js'
import {
  disableEmailOtp,
  disableTwoFactor,
  enableEmailOtp,
  getTwoFactorEvents,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
  startAuthenticatorSetup,
  verifyAuthenticatorSetup,
} from '../controllers/adminTwoFactor.controller.js'

const router = express.Router()

const twoFactorMutationGate = createSecurityGate({
  gateId: 'admin_two_factor_mutation',
  roles: ['owner', 'admin'],
  allowOwner: true,
  allowInSafeMode: false,
})

router.use(requireAdmin)

router.get('/status', getTwoFactorStatus)
router.post('/authenticator/setup-start', twoFactorMutationGate, startAuthenticatorSetup)
router.post('/authenticator/setup-verify', twoFactorMutationGate, verifyAuthenticatorSetup)
router.post('/email/enable', twoFactorMutationGate, enableEmailOtp)
router.post('/email/disable', twoFactorMutationGate, disableEmailOtp)
router.post('/disable', twoFactorMutationGate, disableTwoFactor)
router.post('/recovery-codes/regenerate', twoFactorMutationGate, regenerateRecoveryCodes)
router.get('/events', getTwoFactorEvents)

export default router
