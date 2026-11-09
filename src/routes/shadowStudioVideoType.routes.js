import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getUnclassifiedStudioVideos,
  patchStudioVideoType,
} from '../controllers/shadowStudioVideoType.controller.js'

const router = Router()
const readLimit = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false })
const writeLimit = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false })

router.get('/unclassified', readLimit, requireUser, getUnclassifiedStudioVideos)
router.patch('/videos/:videoId', writeLimit, requireUser, patchStudioVideoType)

export default router
