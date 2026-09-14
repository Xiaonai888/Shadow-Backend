import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getAdminGoogleAdsSettings,
  getPublicGoogleAdsSettings,
  updateAdminGoogleAdsSettings,
} from '../controllers/googleAdsSettings.controller.js'

const router = express.Router()

router.get('/public', getPublicGoogleAdsSettings)
router.get('/admin', requireAdmin, getAdminGoogleAdsSettings)
router.patch('/admin', requireAdmin, updateAdminGoogleAdsSettings)

export default router
