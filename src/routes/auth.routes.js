import express from 'express'
import {
  adminLogin,
  checkAdmin,
  changeAdminPassword,
} from '../controllers/auth.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.post('/login', adminLogin)
router.get('/me', requireAdmin, checkAdmin)
router.patch('/change-password', requireAdmin, changeAdminPassword)

export default router
