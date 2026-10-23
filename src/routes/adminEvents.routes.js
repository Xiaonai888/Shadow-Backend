import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import author100PercentRoutes from './adminAuthor100PercentEvent.routes.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import {
  createEvent,
  deleteEvent,
  listAdminEvents,
  updateEvent,
} from '../controllers/events.controller.js'

const router = express.Router()

const eventPermission = requireAdminPermission('monthly_vote.view')

const adminEventIdentity = (req) => String(
  req.admin?.admin_id || req.admin?.email || ipKeyGenerator(req.ip)
)

const adminEventReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminEventIdentity,
  message: {
    ok: false,
    code: 'ADMIN_EVENT_READ_RATE_LIMIT',
    message: 'Too many event requests. Please try again shortly.',
  },
})

const adminEventWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminEventIdentity,
  message: {
    ok: false,
    code: 'ADMIN_EVENT_WRITE_RATE_LIMIT',
    message: 'Too many event changes. Please try again shortly.',
  },
})

function limitAuthor100Percent(req, res, next) {
  const limiter = req.method === 'GET' ? adminEventReadLimit : adminEventWriteLimit
  return limiter(req, res, next)
}

router.get('/', eventPermission, adminEventReadLimit, listAdminEvents)
router.use('/100-percent', eventPermission, limitAuthor100Percent, author100PercentRoutes)
router.post('/', eventPermission, adminEventWriteLimit, createEvent)
router.patch('/:eventId', eventPermission, adminEventWriteLimit, updateEvent)
router.delete('/:eventId', eventPermission, adminEventWriteLimit, deleteEvent)

export default router
