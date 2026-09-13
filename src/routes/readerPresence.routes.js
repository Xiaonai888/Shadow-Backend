import express from 'express'
import { heartbeatReaderPresence } from '../controllers/readerPresence.controller.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

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
  requireUser,
  readerPresenceRateLimit,
  heartbeatReaderPresence
)

export default router
