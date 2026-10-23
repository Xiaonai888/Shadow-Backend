import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import {
  getChatTapIndicatorImage,
  initiateChatTapIndicatorImage,
  completeChatTapIndicatorImage,
  cancelChatTapIndicatorUpload,
  deleteChatTapIndicatorImage,
} from '../controllers/readerChatIndicator.controller.js'

const router = express.Router()

router.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}))

router.use(requireUser)

router.use(createRateLimit({
  key: 'reader-chat-indicator',
  windowMs: 60 * 1000,
  max: 60,
  identity: (req) => req.user?.user_id || req.user?.id,
}))

router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  next()
})

function handle(handler) {
  return (req, res, next) =>
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        if (res.headersSent) return next(error)

        const safe =
          Number.isInteger(error?.statusCode) &&
          error.statusCode >= 400 &&
          error.statusCode <= 599

        if (!safe) {
          console.error('CHAT_INDICATOR_API_ERROR', {
            code: error?.code || 'UNKNOWN',
          })
        }

        res.status(safe ? error.statusCode : 503).json({
          ok: false,
          code: safe
            ? error.code
            : 'CHAT_INDICATOR_UNAVAILABLE',
          message: safe
            ? error.code
            : 'Chat indicator temporarily unavailable',
        })
      })
}

router.get('/image', handle(getChatTapIndicatorImage))
router.post('/image/init', handle(initiateChatTapIndicatorImage))
router.post('/image/complete', handle(completeChatTapIndicatorImage))
router.post('/image/cancel', handle(cancelChatTapIndicatorUpload))
router.delete('/image/:id', handle(deleteChatTapIndicatorImage))

export default router
