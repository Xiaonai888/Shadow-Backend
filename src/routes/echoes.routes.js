import express from 'express'
import jwt from 'jsonwebtoken'
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

router.get('/feed', requireUser, getSocialEchoFeed)
router.get('/me', requireUser, getMySocialEchoes)
router.get('/received', requireUser, getReceivedSocialEchoes)
router.get(
  '/user/:username',
  requireUser,
  getSocialEchoesByUsername
)
router.get(
  '/source/:sourceType/:sourceId',
  optionalUser,
  getSocialEchoesBySource
)
router.post('/', requireUser, createSocialEcho)
router.delete('/:echoId', requireUser, deleteSocialEcho)
router.get('/story/:storyId', optionalUser, getStoryEchoes)
router.get('/episode/:episodeId', optionalUser, getEpisodeEchoes)
router.post('/episode/:episodeId', requireUser, createEpisodeEcho)

export default router
