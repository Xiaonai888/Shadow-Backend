import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  blockAdminSpamGuardPermanently,
  getAdminSpamGuardEvents,
  getAdminSpamGuardOverview,
  getAdminSpamGuardStates,
  releaseAdminSpamGuardCooldown,
  releaseAdminSpamGuardQuarantine,
  unblockAdminSpamGuardPermanent,
} from '../controllers/adminSpamGuard.controller.js'

const router = express.Router()

router.use(requireAdmin)

router.get('/overview', getAdminSpamGuardOverview)
router.get('/states', getAdminSpamGuardStates)
router.get('/events', getAdminSpamGuardEvents)
router.patch('/states/:stateId/release', releaseAdminSpamGuardCooldown)
router.patch('/states/:stateId/release-quarantine', releaseAdminSpamGuardQuarantine)
router.patch('/states/:stateId/permanent-block', blockAdminSpamGuardPermanently)
router.patch('/states/:stateId/unblock', unblockAdminSpamGuardPermanent)

export default router
