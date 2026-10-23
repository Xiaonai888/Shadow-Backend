import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { heartbeatReaderPresence } from '../controllers/readerPresence.controller.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

const readerPresenceSafetyLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 2000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'READER_PRESENCE_SAFETY_LIMIT',
    message: 'Too many presence requests. Please retry shortly.',
  },
})

const readerPresenceRateLimit =
  createRateLimit({
    key: 'reader-presence',
    windowMs: 60 * 1000,
    max: 120,
    message:
      'Too many presence updates. Please wait before trying again.',
    identity: (req) =>
      req.user?.user_id,
  })

router.post(
  '/heartbeat',
  readerPresenceSafetyLimit,
  requireUser,
  readerPresenceRateLimit,
  heartbeatReaderPresence
)

export default router
