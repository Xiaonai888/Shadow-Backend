import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
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
  dest: os.tmpdir(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },
})

async function removeTempFile(req) {
  if (!req.file?.path) return
  await unlink(req.file.path).catch(() => {})
}

function cleanupTempFile(req, res, next) {
  let cleaned = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    removeTempFile(req).catch(() => {})
  }

  res.once('finish', cleanup)
  res.once('close', cleanup)
  next()
}

function uploadTaskCenterCover(req, res, next) {
  upload.single('cover')(req, res, (error) => {
    if (!error) return next()

    removeTempFile(req).catch(() => {})

    const status =
      error.code === 'LIMIT_FILE_SIZE'
        ? 413
        : 400

    return res.status(status).json({
      ok: false,
      code:
        error.code ||
        'TASK_CENTER_COVER_UPLOAD_INVALID',
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Cover image must be 5 MB or smaller'
          : error.message ||
            'Invalid cover image',
    })
  })
}

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

router.put(
  '/admin/cover',
  requireAdmin,
  uploadTaskCenterCover,
  cleanupTempFile,
  updateAdminTaskCenterCover
)

export default router
