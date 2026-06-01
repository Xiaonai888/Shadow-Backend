import express from 'express'
import {
  adminForgotPassword,
  adminLogin,
  adminResetPassword,
  checkAdmin,
  changeAdminPassword,
} from '../controllers/auth.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.post('/login', adminLogin)
router.post('/admin-forgot-password', adminForgotPassword)
router.post('/admin-reset-password', adminResetPassword)
router.get('/me', requireAdmin, checkAdmin)
router.patch('/change-password', requireAdmin, changeAdminPassword)

export default router
