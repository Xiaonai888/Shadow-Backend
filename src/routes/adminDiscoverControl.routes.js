import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  addDiscoverControlAuthor,
  getDiscoverControlAuthors,
  removeDiscoverControlAuthor,
  searchDiscoverControlAuthors,
} from '../controllers/adminDiscoverControl.controller.js'

const router = express.Router()

const adminDiscoverIdentity = (req) => String(
  req.admin?.admin_id ||
  req.admin?.id ||
  req.admin?.sub ||
  req.admin?.email ||
  ipKeyGenerator(req.ip)
)

const adminDiscoverReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminDiscoverIdentity,
  message: {
    ok: false,
    code: 'ADMIN_DISCOVER_CONTROL_READ_RATE_LIMIT',
    message: 'Too many Discover Control requests. Please retry shortly.',
  },
})

const adminDiscoverWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminDiscoverIdentity,
  message: {
    ok: false,
    code: 'ADMIN_DISCOVER_CONTROL_WRITE_RATE_LIMIT',
    message: 'Too many Discover Control changes. Please retry shortly.',
  },
})

router.use(rateLimit({
  windowMs: 60000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}))

router.use(requireAdmin)

router.get('/authors', adminDiscoverReadLimit, getDiscoverControlAuthors)
router.get('/search', adminDiscoverReadLimit, searchDiscoverControlAuthors)
router.post('/authors', adminDiscoverWriteLimit, addDiscoverControlAuthor)
router.delete('/authors/:authorPageId', adminDiscoverWriteLimit, removeDiscoverControlAuthor)

export default router
