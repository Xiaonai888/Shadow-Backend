import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
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
import {
  getAdminInternationalReadingMissions,
  createAdminInternationalReadingMission,
  updateAdminInternationalReadingMission,
  deleteAdminInternationalReadingMission,
  updateAdminInternationalReadingMissionMode,
  rotateAdminInternationalReadingMissions,
} from '../controllers/adminTaskCenterInternational.controller.js'
import path from 'node:path'

const router = express.Router()

const taskCenterPublicLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'TASK_CENTER_PUBLIC_RATE_LIMIT',
    message: 'Too many Task Center requests. Please retry shortly.',
  },
})

const adminTaskCenterIdentity = (req) => String(
  req.admin?.admin_id ||
  req.admin?.id ||
  req.admin?.sub ||
  req.admin?.email ||
  ipKeyGenerator(req.ip)
)

const adminTaskCenterReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminTaskCenterIdentity,
  message: {
    ok: false,
    code: 'ADMIN_TASK_CENTER_READ_RATE_LIMIT',
    message: 'Too many Task Center requests. Please retry shortly.',
  },
})

const adminTaskCenterWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminTaskCenterIdentity,
  message: {
    ok: false,
    code: 'ADMIN_TASK_CENTER_WRITE_RATE_LIMIT',
    message: 'Too many Task Center changes. Please retry shortly.',
  },
})

const taskCenterAutoRunLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'TASK_CENTER_AUTO_RUN_RATE_LIMIT',
    message: 'Too many Task Center rotation requests. Please retry shortly.',
  },
})

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },
})

async function removeTempFile(req) {
  const fileName = req.file?.filename
  if (typeof fileName !== 'string' || !/^[a-f0-9]{32}$/i.test(fileName)) return
  const expectedPath = path.join(os.tmpdir(), fileName)
  if (req.file.path !== expectedPath) return
  await unlink(expectedPath).catch(() => {})
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

router.get('/public/version', taskCenterPublicLimit, getPublicTaskCenterVersion)
router.get('/public', taskCenterPublicLimit, getPublicTaskCenterSettings)
router.get('/admin', requireAdmin, adminTaskCenterReadLimit, getAdminTaskCenterSettings)
router.get('/admin/reader-activity', requireAdmin, adminTaskCenterReadLimit, getAdminReaderActivity)
router.get('/admin/reading-missions', requireAdmin, adminTaskCenterReadLimit, getAdminReadingMissions)
router.post('/admin/reading-missions', requireAdmin, adminTaskCenterWriteLimit, createAdminReadingMission)
router.put('/admin/reading-missions/:missionId', requireAdmin, adminTaskCenterWriteLimit, updateAdminReadingMission)
router.delete('/admin/reading-missions/:missionId', requireAdmin, adminTaskCenterWriteLimit, deleteAdminReadingMission)
router.get('/admin/international/reading-missions', requireAdmin, adminTaskCenterReadLimit, getAdminInternationalReadingMissions)
router.post('/admin/international/reading-missions', requireAdmin, adminTaskCenterWriteLimit, createAdminInternationalReadingMission)
router.put('/admin/international/reading-missions/:missionId', requireAdmin, adminTaskCenterWriteLimit, updateAdminInternationalReadingMission)
router.delete('/admin/international/reading-missions/:missionId', requireAdmin, adminTaskCenterWriteLimit, deleteAdminInternationalReadingMission)
router.put('/admin/international/reading-mode', requireAdmin, adminTaskCenterWriteLimit, updateAdminInternationalReadingMissionMode)
router.post('/admin/international/auto-rotate', requireAdmin, adminTaskCenterWriteLimit, rotateAdminInternationalReadingMissions)
router.put('/admin/reading-task', requireAdmin, adminTaskCenterWriteLimit, updateAdminReadingTask)
router.put('/admin/reading-mode', requireAdmin, adminTaskCenterWriteLimit, updateAdminReadingMissionMode)
router.post('/admin/auto-rotate', requireAdmin, adminTaskCenterWriteLimit, rotateAdminTaskCenterAutoStories)
router.post('/auto-rotate/run', taskCenterAutoRunLimit, runTaskCenterAutoRotation)

router.put(
  '/admin/cover',
  requireAdmin,
  adminTaskCenterWriteLimit,
  uploadTaskCenterCover,
  cleanupTempFile,
  updateAdminTaskCenterCover
)

export default router
