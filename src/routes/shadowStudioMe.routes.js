import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getStudioMeSummary,
  listStudioMeArchive,
  listStudioMeTrash,
  listStudioMeVideos,
  setStudioMeArchived,
  moveStudioMeToTrash,
  restoreStudioMeFromTrash,
  deleteStudioMeForever,
} from '../controllers/shadowStudioMe.controller.js'

const router = Router()
const readLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'STUDIO_ME_RATE_LIMITED', message: 'Too many Studio requests.' },
})
const writeLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'STUDIO_ME_WRITE_RATE_LIMITED', message: 'Too many Studio changes.' },
})

router.get('/summary', readLimit, requireUser, getStudioMeSummary)
router.get('/videos', readLimit, requireUser, listStudioMeVideos)
router.get('/archive', readLimit, requireUser, listStudioMeArchive)
router.get('/trash', readLimit, requireUser, listStudioMeTrash)
router.patch('/videos/:id/archive', writeLimit, requireUser, setStudioMeArchived)
router.delete('/videos/:id', writeLimit, requireUser, moveStudioMeToTrash)
router.post('/trash/:id/restore', writeLimit, requireUser, restoreStudioMeFromTrash)
router.delete('/trash/:id', writeLimit, requireUser, deleteStudioMeForever)

export default router
