import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  listMyRestrictedReaders,
  searchReadersForRestriction,
  restrictReader,
  unrestrictReader,
} from '../controllers/readerRestrictions.controller.js'

const router = express.Router()

const restrictionLimitKey = (req) => {
  const readerId = String(req.user?.user_id || req.user?.id || 'unauthenticated')
  return `${readerId}:${req.method}:${req.route?.path || req.path}`
}

const readLimit = rateLimit({
  windowMs: 60000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: restrictionLimitKey,
  message: {
    ok: false,
    code: 'READER_RESTRICTIONS_READ_RATE_LIMIT',
    message: 'Too many restriction requests. Please try again shortly.',
  },
})

const writeLimit = rateLimit({
  windowMs: 60000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: restrictionLimitKey,
  message: {
    ok: false,
    code: 'READER_RESTRICTIONS_WRITE_RATE_LIMIT',
    message: 'Too many restriction updates. Please try again shortly.',
  },
})

router.use(requireUser)
router.get('/', readLimit, listMyRestrictedReaders)
router.get('/search', readLimit, searchReadersForRestriction)
router.post('/:readerId', writeLimit, restrictReader)
router.delete('/:readerId', writeLimit, unrestrictReader)

export default router
