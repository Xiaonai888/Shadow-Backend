import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getFastVideoLikes,
  getMyFastVideoLike,
  setMyFastVideoLike,
} from '../controllers/fastLikes.controller.js'

// NEW: standalone Fast Likes routes.
// LATER connect in src/routes/fast.routes.js:
//   import fastLikesRouter from './fastLikes.routes.js'
//   router.use('/videos', fastLikesRouter)
//
// Endpoints after mounting:
// GET /api/fast/videos/:id/likes        (public count)
// GET /api/fast/videos/:id/likes/me     (reader's status + count)
// PUT /api/fast/videos/:id/likes/me     (reader Like/Unlike)

const router = Router()

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

router.get('/:id/likes', getFastVideoLikes)
router.get('/:id/likes/me', requireUser, getMyFastVideoLike)
router.put('/:id/likes/me', requireUser, likeWriteLimit, setMyFastVideoLike)

export default router
