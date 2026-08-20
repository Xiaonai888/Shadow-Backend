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

const router = express.Router()

const viewExclusive = requireAdminPermission('shadow_exclusive.view')
const manageExclusive = requireAdminPermission('shadow_exclusive.manage')

router.get('/stories', viewExclusive, listAdminExclusiveStories)
router.patch('/stories/:storyId/request', manageExclusive, requestShadowExclusive)
router.patch('/stories/:storyId/approve', manageExclusive, approveShadowExclusive)
router.patch('/stories/:storyId/reject', manageExclusive, rejectShadowExclusive)
router.patch('/stories/:storyId/remove', manageExclusive, removeShadowExclusive)
router.patch('/stories/:storyId/sections', manageExclusive, updateShadowExclusiveSections)

export default router
