import express from 'express'
import {
  approveShadowExclusive,
  listAdminExclusiveStories,
  rejectShadowExclusive,
  removeShadowExclusive,
  requestShadowExclusive,
  updateShadowExclusiveSections,
} from '../controllers/adminExclusive.controller.js'

const router = express.Router()

router.get('/stories', listAdminExclusiveStories)
router.patch('/stories/:storyId/request', requestShadowExclusive)
router.patch('/stories/:storyId/approve', approveShadowExclusive)
router.patch('/stories/:storyId/reject', rejectShadowExclusive)
router.patch('/stories/:storyId/remove', removeShadowExclusive)
router.patch('/stories/:storyId/sections', updateShadowExclusiveSections)

export default router
