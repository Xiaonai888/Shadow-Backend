import express from 'express'
import {
  adminForgotPassword,
  adminLogin,
  adminLoginTwoFactorEmailSend,
  adminLoginTwoFactorVerify,
  adminLoginPasskeyPinVerify,
  adminResetPassword,
  checkAdmin,
  changeAdminPassword,
  adminLoginPasskeyPinResetConfirm,
  adminLoginPasskeyPinResetEmailSend,
} from '../controllers/auth.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { verifyTurnstile } from '../middleware/turnstile.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'

const router = express.Router()

const adminLoginLimit = createRateLimit({
  key: 'admin-login',
  windowMs: 60000,
  max: 10,
  message: 'Too many login attempts. Please wait and try again.',
})

const adminResetRequestLimit = createRateLimit({
  key: 'admin-reset-request',
  windowMs: 600000,
  max: 5,
  message: 'Too many reset requests. Please wait and try again.',
})

const adminResetConfirmLimit = createRateLimit({
  key: 'admin-reset-confirm',
  windowMs: 600000,
  max: 10,
  message: 'Too many reset attempts. Please wait and try again.',
})

router.post('/login', adminLoginLimit, verifyTurnstile, adminLogin)
router.post('/login/2fa/verify', adminLoginLimit, adminLoginTwoFactorVerify)
router.post('/login/passkey-pin/verify', adminLoginLimit, adminLoginPasskeyPinVerify)
router.post('/login/2fa/email/send', adminLoginLimit, adminLoginTwoFactorEmailSend)
router.post('/admin-forgot-password', adminResetRequestLimit, verifyTurnstile, adminForgotPassword)
router.post('/admin-reset-password', adminResetConfirmLimit, verifyTurnstile, adminResetPassword)
router.get('/me', requireAdmin, checkAdmin)
router.patch('/change-password', requireAdmin, changeAdminPassword)
router.post('/login/passkey-pin/reset/email/send', adminLoginLimit, adminLoginPasskeyPinResetEmailSend)
router.post('/login/passkey-pin/reset/confirm', adminLoginLimit, adminLoginPasskeyPinResetConfirm)

export default router
