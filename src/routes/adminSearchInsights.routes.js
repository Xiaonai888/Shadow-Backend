import express from 'express'
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
router.post(
  '/groups/:groupId/split',
  viewSearchInsights,
  splitAdminSearchGroupAlias
)

export default router
