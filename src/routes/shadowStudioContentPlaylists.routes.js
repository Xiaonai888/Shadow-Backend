import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getMyStudioPlaylistVideos,
  getMyStudioPlaylistSummaries,
} from '../controllers/shadowStudioContentPlaylists.controller.js'

const router = Router()
const readLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'STUDIO_CONTENT_RATE_LIMITED', message: 'Too many Playlist requests.' },
})

router.get('/playlists/summaries', readLimit, requireUser, getMyStudioPlaylistSummaries)
router.get('/playlists/:playlistId/videos', readLimit, requireUser, getMyStudioPlaylistVideos)

export default router
