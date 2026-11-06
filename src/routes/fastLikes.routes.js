import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getFastVideoLikes,
  getMyFastVideoLike,
  setMyFastVideoLike,
} from '../controllers/fastLikes.controller.js'

// Standalone Fast Likes routes, mounted at /videos by fast.routes.js.
// GET /api/fast/videos/:id/likes       (public count)
// GET /api/fast/videos/:id/likes/me    (reader's status + count)
// PUT /api/fast/videos/:id/likes/me    (reader Like/Unlike)

const router = Router()

// Always run an IP-based limiter BEFORE authentication or controller logic.
const likeReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'FAST_LIKE_READ_RATE_LIMITED',
    message: 'Too many Like status requests. Please try again shortly.',
  },
})

const likeWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'FAST_LIKE_RATE_LIMITED',
    message: 'Too many Like requests. Please try again shortly.',
  },
})

router.get('/:id/likes', likeReadLimit, getFastVideoLikes)
router.get('/:id/likes/me', likeReadLimit, requireUser, getMyFastVideoLike)
router.put('/:id/likes/me', likeWriteLimit, requireUser, setMyFastVideoLike)

export default router
