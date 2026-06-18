import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getAdminSpamGuardEvents,
  getAdminSpamGuardOverview,
  getAdminSpamGuardStates,
  releaseAdminSpamGuardCooldown,
} from '../controllers/adminSpamGuard.controller.js'

const router = express.Router()

router.use(requireAdmin)

router.get('/overview', getAdminSpamGuardOverview)
router.get('/states', getAdminSpamGuardStates)
router.get('/events', getAdminSpamGuardEvents)
router.patch('/states/:stateId/release', releaseAdminSpamGuardCooldown)

export default router
