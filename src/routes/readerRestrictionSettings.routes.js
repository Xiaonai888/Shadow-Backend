import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getMyReaderRestrictionSettings,
  updateMyReaderRestrictionSetting,
} from '../controllers/readerRestrictionSettings.controller.js'

const router = express.Router()

const readerRestrictionSettingsReadLimit = rateLimit({
  windowMs: 60000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || 'unauthenticated'),
  message: {
    ok: false,
    code: 'READER_RESTRICTION_SETTINGS_READ_RATE_LIMIT',
    message: 'Too many restriction settings requests. Please try again shortly.',
  },
})

const readerRestrictionSettingsWriteLimit = rateLimit({
  windowMs: 60000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || 'unauthenticated'),
  message: {
    ok: false,
    code: 'READER_RESTRICTION_SETTINGS_WRITE_RATE_LIMIT',
    message: 'Too many restriction settings updates. Please try again shortly.',
  },
})

router.get('/', requireUser, readerRestrictionSettingsReadLimit, getMyReaderRestrictionSettings)
router.patch('/', requireUser, readerRestrictionSettingsWriteLimit, updateMyReaderRestrictionSetting)

export default router
