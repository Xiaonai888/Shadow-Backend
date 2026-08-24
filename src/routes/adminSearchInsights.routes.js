import express from 'express'
import { getAdminSearchInsights } from '../controllers/adminSearchInsights.controller.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'

const router = express.Router()

const viewSearchInsights = requireAdminPermission(
  'task_center.view'
)

router.get('/', viewSearchInsights, getAdminSearchInsights)

export default router
