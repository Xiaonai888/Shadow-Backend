import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  disableEmailOtp,
‌  enableEmailOtp,
  disableTwoFactor,
  getTwoFactorEvents,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
  startAuthenticatorSetup,
  verifyAuthenticatorSetup,
} from '../controllers/adminTwoFactor.controller.js'

const router = express.Router()

router.use(requireAdmin)

router.get('/status', getTwoFactorStatus)
router.post('/authenticator/setup-start', startAuthenticatorSetup)
router.post('/authenticator/setup-verify', verifyAuthenticatorSetup)
router.post('/email/enable', enableEmailOtp)
router.post('/email/disable', disableEmailOtp)
router.post('/disable', disableTwoFactor)
router.post('/recovery-codes/regenerate', regenerateRecoveryCodes)
router.get('/events', getTwoFactorEvents)

export default router
