import express from 'express'
import {
  getAdminAdvertisements,
  getPublicAdvertisement,
  updateAdminAdvertisement,
} from '../controllers/advertisements.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/public', getPublicAdvertisement)
router.get('/admin', requireAdmin, getAdminAdvertisements)
router.put('/admin/:placement', requireAdmin, updateAdminAdvertisement)

export default router
