import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { requireUser } from '../middleware/user.middleware.js'
import {
  clearSpinResults,
  createSpinResult,
  createSpinWheel,
  deleteSpinMedia,
  deleteSpinResult,
  deleteSpinWheel,
  getSpinResults,
  getSpinWheels,
  updateSpinWheel,
  uploadSpinMedia,
} from '../controllers/spin.controller.js'

const router = express.Router()

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

    if (req.file?.path) {
      await unlink(req.file.path).catch(() => {})
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

router.use(requireUser)

router.get('/wheels', getSpinWheels)
router.post('/wheels', createSpinWheel)
router.put('/wheels/:wheelId', updateSpinWheel)
router.delete('/wheels/:wheelId', deleteSpinWheel)

router.get('/results', getSpinResults)
router.post('/results', createSpinResult)
router.delete('/results/:resultId', deleteSpinResult)
router.delete('/results', clearSpinResults)

router.post('/media', uploadImage, uploadSpinMedia)
router.delete('/media', deleteSpinMedia)

export default router
