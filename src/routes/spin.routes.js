import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  searchSpinGameSession,
  clearSpinResults,
  createSpinResult,
  createSpinWheel,
  deleteSpinMedia,
  deleteSpinResult,
  deleteSpinWheel,
  getSpinResults,
  getSpinGameSessionStatus,
  startSpinGameSession,
  getSpinWheels,
  updateSpinWheel,
  uploadSpinMedia,
} from '../controllers/spin.controller.js'
import path from 'node:path'

const router = express.Router()

const spinRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || req.user?.session_id || 'unauthenticated'),
  message: {
    ok: false,
    code: 'SPIN_RATE_LIMIT',
    message: 'Too many spin requests. Please try again shortly.',
  },
})

const spinUploadRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || req.user?.session_id || 'unauthenticated'),
  message: {
    ok: false,
    code: 'SPIN_UPLOAD_RATE_LIMIT',
    message: 'Too many spin image uploads. Please try again shortly.',
  },
})

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
  },
})

function uploadImage(req, res, next) {
  upload.single('image')(req, res, async (error) => {
    if (!error) return next()

    const fileName = req.file?.filename
    if (typeof fileName === 'string' && /^[a-f0-9]{32}$/i.test(fileName)) {
      const expectedPath = path.join(os.tmpdir(), fileName)
      if (req.file.path === expectedPath) {
        await unlink(expectedPath).catch(() => {})
      }
    }

    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        ok: false,
        code: 'SPIN_IMAGE_TOO_LARGE',
        message: 'Spin image must be 2 MB or smaller',
      })
    }

    return res.status(400).json({
      ok: false,
      code: 'SPIN_IMAGE_UPLOAD_INVALID',
      message: error.message || 'Invalid image upload',
    })
  })
}
router.use(rateLimit({
  windowMs: 60000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}))

router.use(requireUser)
router.use(spinRateLimit)

router.get('/sessions/status', getSpinGameSessionStatus)
router.post('/sessions/start', startSpinGameSession)
router.get('/sessions/:sessionId/search', searchSpinGameSession)

router.get('/wheels', getSpinWheels)
router.post('/wheels', createSpinWheel)
router.put('/wheels/:wheelId', updateSpinWheel)
router.delete('/wheels/:wheelId', deleteSpinWheel)

router.get('/results', getSpinResults)
router.post('/results', createSpinResult)
router.delete('/results/:resultId', deleteSpinResult)
router.delete('/results', clearSpinResults)

router.post('/media', spinUploadRateLimit, uploadImage, uploadSpinMedia)
router.delete('/media', deleteSpinMedia)

export default router
