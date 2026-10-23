import express from 'express'
import { rateLimit } from 'express-rate-limit'
import {
  getAdminSearchInsights,
  mergeAdminSearchGroups,
  renameAdminSearchGroup,
  setAdminSearchGroupIgnored,
  splitAdminSearchGroupAlias,
} from '../controllers/adminSearchInsights.controller.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'

const router = express.Router()

const viewSearchInsights = requireAdminPermission(
  'task_center.view'
)

const adminSearchReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.admin.admin_id),
  message: {
    ok: false,
    code: 'ADMIN_SEARCH_READ_RATE_LIMIT',
    message: 'Too many search insight requests. Please retry shortly.',
  },
})

const adminSearchWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.admin.admin_id),
  message: {
    ok: false,
    code: 'ADMIN_SEARCH_WRITE_RATE_LIMIT',
    message: 'Too many search insight changes. Please retry shortly.',
  },
})

router.get('/', viewSearchInsights, adminSearchReadLimit, getAdminSearchInsights)
router.patch(
  '/groups/:groupId/rename',
  viewSearchInsights,
  adminSearchWriteLimit,
  renameAdminSearchGroup
)
router.patch(
  '/groups/:groupId/ignore',
  viewSearchInsights,
  adminSearchWriteLimit,
  setAdminSearchGroupIgnored
)
router.post(
  '/groups/:groupId/merge',
  viewSearchInsights,
  adminSearchWriteLimit,
  mergeAdminSearchGroups
)
router.post(
  '/groups/:groupId/split',
  viewSearchInsights,
  adminSearchWriteLimit,
  splitAdminSearchGroupAlias
)

export default router
