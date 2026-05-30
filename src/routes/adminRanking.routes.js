import express from 'express'
import { getAdminStoryRanking } from '../controllers/adminRanking.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/stories', requireAdmin, getAdminStoryRanking)

export default router
