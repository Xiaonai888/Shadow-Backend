import express from 'express'
import multer from 'multer'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getPublicTaskCenterVersion,
  getPublicTaskCenterSettings,
  getAdminTaskCenterSettings,
  getAdminReadingMissions,
  createAdminReadingMission,
  updateAdminReadingMission,
  deleteAdminReadingMission,
  updateAdminReadingTask,
  updateAdminTaskCenterCover,
  updateAdminReadingMissionMode,
  rotateAdminTaskCenterAutoStories,
  runTaskCenterAutoRotation,
  getAdminReaderActivity,
} from '../controllers/adminTaskCenter.controller.js'

const router = express.Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
})

router.get('/public/version', getPublicTaskCenterVersion)
router.get('/public', getPublicTaskCenterSettings)
router.get('/admin', requireAdmin, getAdminTaskCenterSettings)
router.get('/admin/reader-activity', requireAdmin, getAdminReaderActivity)
router.get('/admin/reading-missions', requireAdmin, getAdminReadingMissions)
router.post('/admin/reading-missions', requireAdmin, createAdminReadingMission)
router.put('/admin/reading-missions/:missionId', requireAdmin, updateAdminReadingMission)
router.delete('/admin/reading-missions/:missionId', requireAdmin, deleteAdminReadingMission)
router.put('/admin/reading-task', requireAdmin, updateAdminReadingTask)
router.put('/admin/reading-mode', requireAdmin, updateAdminReadingMissionMode)
router.post('/admin/auto-rotate', requireAdmin, rotateAdminTaskCenterAutoStories)
router.post('/auto-rotate/run', runTaskCenterAutoRotation)
router.put('/admin/cover', requireAdmin, upload.single('cover'), updateAdminTaskCenterCover)

export default router
