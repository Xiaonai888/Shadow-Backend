import express from 'express'
import multer from 'multer'
import {
  getAdminAdvertisementLogs,
  getAdminAdvertisements,
  getPublicAdvertisement,
  updateAdminAdvertisement,
} from '../controllers/advertisements.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
})

router.get('/public', getPublicAdvertisement)
router.get('/admin', requireAdmin, getAdminAdvertisements).
router.get('/admin/logs', requireAdmin, getAdminAdvertisementLogs)
router.put('/admin/:placement', requireAdmin, upload.single('image'), updateAdminAdvertisement)

export default router
