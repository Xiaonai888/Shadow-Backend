import express from 'express'
import {
  adminForgotPassword,
  adminLogin,
  adminResetPassword,
  checkAdmin,
  changeAdminPassword,
} from '../controllers/auth.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { verifyTurnstile } from '../middleware/turnstile.middleware.js'

const router = express.Router()

router.post('/login', verifyTurnstile, adminLogin)
router.post('/admin-forgot-password', verifyTurnstile, adminForgotPassword)
router.post('/admin-reset-password', verifyTurnstile, adminResetPassword)
router.get('/me', requireAdmin, checkAdmin)
router.patch('/change-password', requireAdmin, changeAdminPassword)

export default router
