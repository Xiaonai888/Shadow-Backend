import express from 'express'
import multer from 'multer'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getPublicTaskCenterSettings,
  getAdminTaskCenterSettings,
  updateAdminReadingTask,
  updateAdminTaskCenterCover,
} from '../controllers/adminTaskCenter.controller.js'

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
})

router.get('/public', getPublicTaskCenterSettings)
router.get('/admin', requireAdmin, getAdminTaskCenterSettings)
router.put('/admin/reading-task', requireAdmin, updateAdminReadingTask)
router.put('/admin/cover', requireAdmin, upload.single('cover'), updateAdminTaskCenterCover)

export default router
