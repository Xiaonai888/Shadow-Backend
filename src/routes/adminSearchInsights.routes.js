import express from 'express'
import {
  getAdminSearchInsights,
  mergeAdminSearchGroups,
  renameAdminSearchGroup,
  setAdminSearchGroupIgnored,
} from '../controllers/adminSearchInsights.controller.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'

const router = express.Router()

const viewSearchInsights = requireAdminPermission(
  'task_center.view'
)

router.get('/', viewSearchInsights, getAdminSearchInsights)
router.patch(
  '/groups/:groupId/rename',
  viewSearchInsights,
  renameAdminSearchGroup
)
router.patch(
  '/groups/:groupId/ignore',
  viewSearchInsights,
  setAdminSearchGroupIgnored
)
router.post(
  '/groups/:groupId/merge',
  viewSearchInsights,
  mergeAdminSearchGroups
)

export default router
