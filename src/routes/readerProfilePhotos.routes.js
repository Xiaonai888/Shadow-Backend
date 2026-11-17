import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  listMyReaderProfilePhotos,
  registerMyReaderProfilePhoto,
  removeMyReaderProfilePhoto,
} from '../controllers/readerProfilePhotos.controller.js'

const router = express.Router()

const readLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 90,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id),
})

const writeLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id),
})

router.use(requireUser)
router.get('/', readLimit, listMyReaderProfilePhotos)
router.post('/', writeLimit, registerMyReaderProfilePhoto)
router.delete('/:photoId', writeLimit, removeMyReaderProfilePhoto)

export default router
