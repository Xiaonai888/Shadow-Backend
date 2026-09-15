import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { createSecurityGate } from '../middleware/securityGate.middleware.js'
import { guardSecurityMutation } from '../services/tamperGuard.service.js'
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

const observeSpamGuardRelease = (action) => (req, res, next) => {
  const role = String(req.admin?.role || '').trim().toLowerCase()

  guardSecurityMutation({
    target: 'spam_guard',
    action,
    actor:
      req.admin?.admin_id
      || req.admin?.id
      || req.admin?.email
      || role
      || 'admin',
    authorized: role === 'owner' || role === 'admin',
    allowInSafeMode: false,
    reason:
      role === 'owner' || role === 'admin'
        ? 'Spam Guard protection release attempted during protected state'
        : 'Unauthorized role attempted to release Spam Guard protection',
    details: {
      role: role || 'unknown',
      state_id: req.params?.stateId || null,
      path: req.originalUrl || req.path || '',
    },
  })

  return next()
}

router.use(requireAdmin)

router.get('/overview', getAdminSpamGuardOverview)
router.get('/states', getAdminSpamGuardStates)
router.get('/events', getAdminSpamGuardEvents)
router.patch(
  '/states/:stateId/release',
  manageSpamGuard,
  observeSpamGuardRelease('unblock'),
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
  observeSpamGuardRelease('release'),
  spamGuardReleaseGate,
  releaseAdminSpamGuardRestriction
)

export default router
