import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { getAdminActivityLogs } from '../controllers/adminActivity.controller.js'

const router = express.Router()

router.get('/', requireAdmin, getAdminActivityLogs)

export default router
