import express from 'express'
import jwt from 'jsonwebtoken'
import { rateLimit } from 'express-rate-limit'
import {
  createEchoV2,
  deleteEchoV2,
  getEchoV2BySource,
  getEchoV2ByUsername,
  getEchoV2Feed,
  getEchoV2Health,
  getMyEchoV2,
  getReceivedEchoV2,
} from '../controllers/echoV2.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

const echoV2ReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 900,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ECHO_V2_READ_RATE_LIMIT',
    message: 'Too many echo requests. Please retry shortly.',
  },
})

const echoV2WriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ECHO_V2_WRITE_RATE_LIMIT',
    message: 'Too many echo actions. Please retry shortly.',
  },
})

function optionalUser(req, res, next) {
  try {
    const authHeader =
      req.headers.authorization || ''
    const token =
      authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : ''

    if (
      !token ||
      !process.env.JWT_SECRET
    ) {
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

router.get(
  '/health',
  echoV2ReadLimit,
  getEchoV2Health
)

router.get(
  '/source/:sourceType/:sourceId',
  echoV2ReadLimit,
  optionalUser,
  getEchoV2BySource
)

router.get(
  '/feed',
  echoV2ReadLimit,
  requireUser,
  getEchoV2Feed
)

router.get(
  '/me',
  echoV2ReadLimit,
  requireUser,
  getMyEchoV2
)

router.get(
  '/received',
  echoV2ReadLimit,
  requireUser,
  getReceivedEchoV2
)

router.get(
  '/user/:username',
  echoV2ReadLimit,
  requireUser,
  getEchoV2ByUsername
)

router.post(
  '/',
  echoV2WriteLimit,
  requireUser,
  createEchoV2
)

router.delete(
  '/:echoId',
  echoV2WriteLimit,
  requireUser,
  deleteEchoV2
)

export default router
