import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getWorkIncidents,
  streamWorkIncidents,
} from '../controllers/adminWork.controller.js'
import { getAdminWorkKillSwitches, setAdminWorkKillSwitch } from '../controllers/adminWorkKillSwitch.controller.js'
import { createSecurityGate } from '../middleware/securityGate.middleware.js'
import { guardSecurityMutation } from '../services/tamperGuard.service.js'

const router = express.Router()

const killSwitchEnableGate = createSecurityGate({
  gateId: 'kill_switch_enable',
  roles: ['owner'],
  allowOwner: true,
  allowInSafeMode: true,
})

const killSwitchDisableGate = createSecurityGate({
  gateId: 'kill_switch_disable',
  roles: ['owner'],
  allowOwner: true,
  allowInSafeMode: false,
})

const observeKillSwitchTamper = (req, res, next) => {
  if (req.body?.enabled !== false) return next()

  const role = String(req.admin?.role || '').trim().toLowerCase()

  guardSecurityMutation({
    target: 'kill_switch',
    action: 'disable',
    actor:
      req.admin?.admin_id
      || req.admin?.id
      || req.admin?.email
      || role
      || 'admin',
    authorized: role === 'owner',
    allowInSafeMode: false,
    reason: role === 'owner'
      ? 'Kill Switch disable attempted during protected state'
      : 'Non-owner attempted to disable Kill Switch',
    details: {
      role: role || 'unknown',
      path: req.originalUrl || req.path || '/api/admin/work/kill-switches',
    },
  })

  return next()
}

const protectKillSwitchMutation = (req, res, next) =>
  (req.body?.enabled === false ? killSwitchDisableGate : killSwitchEnableGate)(req, res, next)

router.use(requireAdmin)

router.get('/events', streamWorkIncidents)
router.get('/incidents', getWorkIncidents)
router.get('/kill-switches', getAdminWorkKillSwitches)
router.put('/kill-switches', observeKillSwitchTamper, protectKillSwitchMutation, setAdminWorkKillSwitch)

export default router
