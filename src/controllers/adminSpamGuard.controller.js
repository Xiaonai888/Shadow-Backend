import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  applyAdminSpamGuardRestriction,
  getAdminSpamGuardEvents,
  getAdminSpamGuardOverview,
  getAdminSpamGuardStates,
  releaseAdminSpamGuardCooldown,
  releaseAdminSpamGuardRestriction,
} from '../controllers/adminSpamGuard.controller.js'

const router = express.Router()

router.use(requireAdmin)

router.get('/overview', getAdminSpamGuardOverview)
router.get('/states', getAdminSpamGuardStates)
router.get('/events', getAdminSpamGuardEvents)
router.patch(
  '/states/:stateId/release',
  releaseAdminSpamGuardCooldown
)
router.patch(
  '/states/:stateId/restrict',
  applyAdminSpamGuardRestriction
)
router.patch(
  '/states/:stateId/release-restriction',
  releaseAdminSpamGuardRestriction
)

export default router
