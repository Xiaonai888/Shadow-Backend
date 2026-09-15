import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { createSecurityGate } from '../middleware/securityGate.middleware.js'
import {
  applyAdminSpamGuardRestriction,
  getAdminSpamGuardEvents,
  getAdminSpamGuardOverview,
  getAdminSpamGuardStates,
  releaseAdminSpamGuardCooldown,
  releaseAdminSpamGuardRestriction,
} from '../controllers/adminSpamGuard.controller.js'

const router = express.Router()

const manageSpamGuard = requireAdminPermission('admin_guard.manage')

const spamGuardDefenseGate = createSecurityGate({
  gateId: 'admin_spam_guard_defense',
  roles: ['owner', 'admin'],
  permissions: ['admin_guard.manage'],
  allowOwner: true,
  allowInSafeMode: true,
})

const spamGuardReleaseGate = createSecurityGate({
  gateId: 'admin_spam_guard_release',
  roles: ['owner', 'admin'],
  permissions: ['admin_guard.manage'],
  allowOwner: true,
  allowInSafeMode: false,
})

router.use(requireAdmin)

router.get('/overview', getAdminSpamGuardOverview)
router.get('/states', getAdminSpamGuardStates)
router.get('/events', getAdminSpamGuardEvents)
router.patch(
  '/states/:stateId/release',
  manageSpamGuard,
  spamGuardReleaseGate,
  releaseAdminSpamGuardCooldown
)
router.patch(
  '/states/:stateId/restrict',
  manageSpamGuard,
  spamGuardDefenseGate,
  applyAdminSpamGuardRestriction
)
router.patch(
  '/states/:stateId/release-restriction',
  manageSpamGuard,
  spamGuardReleaseGate,
  releaseAdminSpamGuardRestriction
)

export default router
