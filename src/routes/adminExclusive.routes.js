import express from 'express'
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

router.get('/stories', viewExclusive, listAdminExclusiveStories)
router.patch(
  '/stories/:storyId/request',
  manageExclusive,
  invalidatePublicStoriesAfterMutation,
  requestShadowExclusive
)
router.patch(
  '/stories/:storyId/approve',
  manageExclusive,
  invalidatePublicStoriesAfterMutation,
  approveShadowExclusive
)
router.patch(
  '/stories/:storyId/reject',
  manageExclusive,
  invalidatePublicStoriesAfterMutation,
  rejectShadowExclusive
)
router.patch(
  '/stories/:storyId/remove',
  manageExclusive,
  invalidatePublicStoriesAfterMutation,
  removeShadowExclusive
)
router.patch(
  '/stories/:storyId/sections',
  manageExclusive,
  invalidatePublicStoriesAfterMutation,
  updateShadowExclusiveSections
)

export default router
