import express from 'express'
import jwt from 'jsonwebtoken'
import { rateLimit } from 'express-rate-limit'
import {
  createEpisodeEcho,
  createSocialEcho,
  deleteSocialEcho,
  getEpisodeEchoes,
  getMySocialEchoes,
  getReceivedSocialEchoes,
  getSocialEchoFeed,
  getSocialEchoesBySource,
  getSocialEchoesByUsername,
  getStoryEchoes,
} from '../controllers/echoes.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

const echoReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 900,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ECHO_READ_RATE_LIMIT',
    message: 'Too many echo requests. Please retry shortly.',
  },
})

const echoWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ECHO_WRITE_RATE_LIMIT',
    message: 'Too many echo actions. Please retry shortly.',
  },
})

function optionalUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : ''

    if (!token || !process.env.JWT_SECRET) {
      return next()
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    )

    if (decoded.type === 'reader') {
      req.user = decoded
    }

    return next()
  } catch {
    return next()
  }
}

router.get('/feed', echoReadLimit, requireUser, getSocialEchoFeed)
router.get('/me', echoReadLimit, requireUser, getMySocialEchoes)
router.get('/received', echoReadLimit, requireUser, getReceivedSocialEchoes)
router.get(
  '/user/:username',
  echoReadLimit,
  requireUser,
  getSocialEchoesByUsername
)
router.get(
  '/source/:sourceType/:sourceId',
  echoReadLimit,
  optionalUser,
  getSocialEchoesBySource
)
router.post('/', echoWriteLimit, requireUser, createSocialEcho)
router.delete('/:echoId', echoWriteLimit, requireUser, deleteSocialEcho)
router.get('/story/:storyId', echoReadLimit, optionalUser, getStoryEchoes)
router.get('/episode/:episodeId', echoReadLimit, optionalUser, getEpisodeEchoes)
router.post('/episode/:episodeId', echoWriteLimit, requireUser, createEpisodeEcho)

export default router
