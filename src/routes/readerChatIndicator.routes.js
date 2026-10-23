import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import {
  approveShadowExclusive,
  listAdminExclusiveStories,
  rejectShadowExclusive,
  removeShadowExclusive,
  requestShadowExclusive,
  updateShadowExclusiveSections,
} from '../controllers/adminExclusive.controller.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { invalidatePublicStoriesCache } from '../services/publicStoriesResponseCache.service.js'

const router = express.Router()

const viewExclusive = requireAdminPermission('shadow_exclusive.view')
const manageExclusive = requireAdminPermission('shadow_exclusive.manage')
const exclusiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(
    req.admin?.admin_id || req.admin?.id || req.admin?.sub || req.admin?.email || ipKeyGenerator(req.ip)
  ),
  message: {
    ok: false,
    message: 'Too many requests. Please try again later.',
  },
})

function invalidatePublicStoriesAfterMutation(req, res, next) {
  res.once('finish', () => {
    if (
      res.statusCode >= 200 &&
      res.statusCode < 300
    ) {
      invalidatePublicStoriesCache()
    }
  })

  next()
}

router.get('/stories', viewExclusive, exclusiveLimiter, listAdminExclusiveStories)
router.patch(
  '/stories/:storyId/request',
  manageExclusive,
  exclusiveLimiter,
  invalidatePublicStoriesAfterMutation,
  requestShadowExclusive
)
router.patch(
  '/stories/:storyId/approve',
  manageExclusive,
  exclusiveLimiter,
  invalidatePublicStoriesAfterMutation,
  approveShadowExclusive
)
router.patch(
  '/stories/:storyId/reject',
  manageExclusive,
  exclusiveLimiter,
  invalidatePublicStoriesAfterMutation,
  rejectShadowExclusive
)
router.patch(
  '/stories/:storyId/remove',
  manageExclusive,
  exclusiveLimiter,
  invalidatePublicStoriesAfterMutation,
  removeShadowExclusive
)
router.patch(
  '/stories/:storyId/sections',
  manageExclusive,
  exclusiveLimiter,
  invalidatePublicStoriesAfterMutation,
  updateShadowExclusiveSections
)

export default router
