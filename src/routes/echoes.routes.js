import express from 'express'
import jwt from 'jsonwebtoken'
import { createEpisodeEcho, getEpisodeEchoes } from '../controllers/echoes.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

function optionalUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

    if (!token || !process.env.JWT_SECRET) return next()

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (decoded.type === 'reader') {
      req.user = decoded
    }

    return next()
  } catch {
    return next()
  }
}

router.get('/episode/:episodeId', optionalUser, getEpisodeEchoes)
router.post('/episode/:episodeId', requireUser, createEpisodeEcho)

export default router
