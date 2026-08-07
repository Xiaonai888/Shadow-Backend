import express from 'express'
import jwt from 'jsonwebtoken'
import {
  createEchoV2,
  deleteEchoV2,
  getEchoV2BySource,
  getEchoV2Health,
} from '../controllers/echoV2.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

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
  getEchoV2Health
)

router.get(
  '/source/:sourceType/:sourceId',
  optionalUser,
  getEchoV2BySource
)

router.post(
  '/',
  requireUser,
  createEchoV2
)

router.delete(
  '/:echoId',
  requireUser,
  deleteEchoV2
)

export default router
