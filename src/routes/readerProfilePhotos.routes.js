import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  listMyReaderProfilePhotos,
  registerMyReaderProfilePhoto,
  removeMyReaderProfilePhoto,
} from '../controllers/readerProfilePhotos.controller.js'

const router = express.Router()

const preAuthReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'READER_PROFILE_PHOTOS_RATE_LIMITED',
    message: 'Too many requests. Please try again later.',
  },
})

const preAuthWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'READER_PROFILE_PHOTOS_RATE_LIMITED',
    message: 'Too many requests. Please try again later.',
  },
})

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

router.get('/', preAuthReadLimit, requireUser, readLimit, listMyReaderProfilePhotos)
router.post('/', preAuthWriteLimit, requireUser, writeLimit, registerMyReaderProfilePhoto)
router.delete('/:photoId', preAuthWriteLimit, requireUser, writeLimit, removeMyReaderProfilePhoto)

export default router
