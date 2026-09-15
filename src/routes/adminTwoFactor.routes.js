import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { createSecurityGate } from '../middleware/securityGate.middleware.js'
import { guardSecurityMutation } from '../services/tamperGuard.service.js'
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

const observeTwoFactorDisable = (control) => (req, res, next) => {
  const role = String(req.admin?.role || '').trim().toLowerCase()
  const authorized = role === 'owner' || role === 'admin'

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
      ? 'Two-factor protection disable attempted during protected state'
      : 'Unauthorized two-factor protection disable attempted',
    details: {
      control,
      role: role || 'unknown',
      path: req.originalUrl || req.path || '',
    },
  })

  return next()
}

router.use(requireAdmin)

router.get('/status', getTwoFactorStatus)
router.post('/authenticator/setup-start', twoFactorMutationGate, startAuthenticatorSetup)
router.post('/authenticator/setup-verify', twoFactorMutationGate, verifyAuthenticatorSetup)
router.post('/email/enable', twoFactorMutationGate, enableEmailOtp)
router.post(
  '/email/disable',
  observeTwoFactorDisable('admin_email_2fa'),
  twoFactorMutationGate,
  disableEmailOtp
)
router.post(
  '/disable',
  observeTwoFactorDisable('admin_two_factor'),
  twoFactorMutationGate,
  disableTwoFactor
)
router.post('/recovery-codes/regenerate', twoFactorMutationGate, regenerateRecoveryCodes)
router.get('/events', getTwoFactorEvents)

export default router
