import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getMyReaderCommentSettings,
  updateMyReaderCommentSettings,
} from '../controllers/readerCommentSettings.controller.js'

const router = express.Router()

const commentSettingsPreAuthLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})

const readerIdentity = (req) => String(req.user?.user_id || req.user?.id || req.user?.session_id || 'unauthenticated')

const commentSettingsReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: readerIdentity,
})

const commentSettingsWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: readerIdentity,
})

router.get('/', commentSettingsPreAuthLimit, requireUser, commentSettingsReadLimit, getMyReaderCommentSettings)
router.put('/', commentSettingsPreAuthLimit, requireUser, commentSettingsWriteLimit, updateMyReaderCommentSettings)

export default router
